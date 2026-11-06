const denseModel = process.env.QDRANT_DENSE_MODEL || "sentence-transformers/all-minilm-l6-v2";
const sparseModel = process.env.QDRANT_SPARSE_MODEL || "qdrant/bm25";
const collectionName = process.env.QDRANT_COLLECTION || "iris_documents";

function configuration() {
  const url = process.env.QDRANT_URL?.replace(/\/$/, "");
  const apiKey = process.env.QDRANT_API_KEY;
  if (!url || !apiKey) throw new Error("Qdrant is not configured. Set QDRANT_URL and QDRANT_API_KEY on the backend.");
  return { url, apiKey };
}

async function qdrantRequest(path, { method = "GET", body } = {}) {
  const { url, apiKey } = configuration();
  let response;
  try {
    response = await fetch(`${url}${path}`, {
      method,
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(`Could not reach Qdrant: ${error.message}`);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.status?.error || result.message || `Qdrant returned HTTP ${response.status}.`);
  }
  return result.result;
}

export function qdrantSettings() {
  return {
    configured: Boolean(process.env.QDRANT_URL && process.env.QDRANT_API_KEY),
    collection: collectionName,
    denseModel,
    sparseModel,
  };
}

export async function getQdrantStatus() {
  const settings = qdrantSettings();
  if (!settings.configured) return { ...settings, connected: false, collectionExists: false, error: "Add QDRANT_URL and QDRANT_API_KEY to the backend environment." };
  try {
    const result = await qdrantRequest(`/collections/${encodeURIComponent(collectionName)}`);
    return { ...settings, connected: true, collectionExists: true, pointsCount: result.points_count ?? 0, indexedVectorsCount: result.indexed_vectors_count ?? 0 };
  } catch (error) {
    if (/not found|doesn't exist|does not exist/i.test(error.message)) {
      return { ...settings, connected: true, collectionExists: false, pointsCount: 0, indexedVectorsCount: 0 };
    }
    return { ...settings, connected: false, collectionExists: false, error: error.message };
  }
}

async function ensureCollection() {
  const status = await getQdrantStatus();
  if (!status.configured) throw new Error(status.error);
  if (!status.connected) throw new Error(status.error || "Qdrant is unavailable.");
  if (!status.collectionExists) {
    try {
      await qdrantRequest(`/collections/${encodeURIComponent(collectionName)}`, {
        method: "PUT",
        body: {
          vectors: { dense_vector: { size: 384, distance: "Cosine" } },
          sparse_vectors: { bm25_sparse_vector: { modifier: "idf" } },
        },
      });
    } catch (error) {
      // Concurrent first ingests can both attempt collection creation.
      if (!/already exists/i.test(error.message)) throw error;
    }
  }

  // Qdrant requires payload indexes for fields used by filtered deletes/searches.
  // Create them on existing collections too, so this also repairs collections
  // created by an earlier version of the ingestion service.
  for (const fieldName of ["documentId", "accessDepartmentIds", "accessUserIds"]) {
    try {
      await qdrantRequest(`/collections/${encodeURIComponent(collectionName)}/index?wait=true`, {
        method: "PUT",
        body: { field_name: fieldName, field_schema: "keyword" },
      });
    } catch (error) {
      if (!/already exists|already indexed/i.test(error.message)) throw error;
    }
  }
}

export async function replaceDocumentPoints(documentId, chunks, payload, onProgress = async () => {}) {
  await ensureCollection();
  // Delete by document payload first, then upsert stable document/chunk point IDs.
  await qdrantRequest(`/collections/${encodeURIComponent(collectionName)}/points/delete?wait=true`, {
    method: "POST",
    body: { filter: { must: [{ key: "documentId", match: { value: documentId } }] } },
  });
  const points = chunks.map((chunk) => ({
    id: chunk.id,
    vector: {
      dense_vector: { text: chunk.text, model: denseModel },
      bm25_sparse_vector: { text: chunk.text, model: sparseModel },
    },
    payload: { ...payload, text: chunk.text, chunkIndex: chunk.index },
  }));
  for (let offset = 0; offset < points.length; offset += 16) {
    await qdrantRequest(`/collections/${encodeURIComponent(collectionName)}/points?wait=true`, {
      method: "PUT",
      body: { points: points.slice(offset, offset + 16) },
    });
    await onProgress(Math.min(offset + 16, points.length));
  }
  return points.length;
}

export async function hybridSearch(queryText, { departmentId, userId, limit = 20, includeRestricted = false }) {
  const status = await getQdrantStatus();
  if (!status.configured || !status.connected) {
    throw new Error(status.error || "Qdrant is unavailable.");
  }
  if (!status.collectionExists) return { points: [], metrics: null };

  const candidateLimit = Math.min(100, Math.max(40, limit * 5));
  const accessFilter = {
    should: [
      { key: "accessDepartmentIds", match: { value: departmentId } },
      { key: "accessUserIds", match: { value: userId } },
    ],
  };
  const collectionPath = `/collections/${encodeURIComponent(collectionName)}/points/query`;
  const filteredByAccess = (body) => ({
    ...body,
    ...(!includeRestricted ? { filter: accessFilter } : {}),
  });
  const [denseResult, keywordResult, fusedResult] = await Promise.all([
    qdrantRequest(collectionPath, {
      method: "POST",
      body: filteredByAccess({
        query: { text: queryText, model: denseModel },
        using: "dense_vector",
        limit: candidateLimit,
        with_payload: ["documentId"],
      }),
    }),
    qdrantRequest(collectionPath, {
      method: "POST",
      body: filteredByAccess({
        query: { text: queryText, model: sparseModel },
        using: "bm25_sparse_vector",
        limit: candidateLimit,
        with_payload: ["documentId"],
      }),
    }),
    qdrantRequest(collectionPath, {
      method: "POST",
      body: {
      prefetch: [
        {
          query: { text: queryText, model: denseModel },
          using: "dense_vector",
          limit: candidateLimit,
          ...(!includeRestricted ? { filter: accessFilter } : {}),
        },
        {
          query: { text: queryText, model: sparseModel },
          using: "bm25_sparse_vector",
          limit: candidateLimit,
          ...(!includeRestricted ? { filter: accessFilter } : {}),
        },
      ],
      query: { fusion: "rrf" },
      ...(!includeRestricted ? { filter: accessFilter } : {}),
      limit: candidateLimit,
      with_payload: true,
      },
    }),
  ]);

  const documentIds = (points) => [...new Set((points || []).map((point) => point.payload?.documentId).filter(Boolean))].slice(0, 20);
  const denseIds = documentIds(denseResult?.points);
  const keywordIds = documentIds(keywordResult?.points);
  const denseSet = new Set(denseIds);
  const keywordSet = new Set(keywordIds);
  const overlap = [...denseSet].filter((documentId) => keywordSet.has(documentId)).length;
  const precision = keywordIds.length ? overlap / keywordIds.length : 0;
  const recall = denseIds.length ? overlap / denseIds.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    points: fusedResult?.points || [],
    metrics: { precision, recall, f1, topK: 20, denseCount: denseIds.length, keywordCount: keywordIds.length, overlapCount: overlap },
  };
}

export async function syncDocumentAccess(documentId, departmentIds, userIds) {
  const status = await getQdrantStatus();
  if (!status.configured || !status.connected) throw new Error(status.error || "Qdrant is unavailable.");
  if (!status.collectionExists) return 0;
  await qdrantRequest(`/collections/${encodeURIComponent(collectionName)}/points/payload?wait=true`, {
    method: "POST",
    body: {
      payload: {
        accessDepartmentIds: [...new Set(departmentIds)],
        accessUserIds: [...new Set(userIds)],
      },
      filter: { must: [{ key: "documentId", match: { value: documentId } }] },
    },
  });
  return 1;
}
