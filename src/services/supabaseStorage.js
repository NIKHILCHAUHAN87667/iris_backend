import getSupabase from "../config/supabase.js";

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET;

export async function uploadFile(path, file, contentType) {
  if (!BUCKET) throw new Error("Supabase Storage is not configured. Set SUPABASE_STORAGE_BUCKET on the backend.");
  const { data, error } = await getSupabase().storage
    .from(BUCKET)
    .upload(path, file, {
      contentType,
      upsert: false,
    });

  if (error) {
    throw error;
  }

  return data;
}

export async function deleteFile(path) {
  const { data, error } = await getSupabase().storage
    .from(BUCKET)
    .remove([path]);

  if (error) {
    throw error;
  }

  return data;
}

export async function createSignedUrl(path, expiresIn = 300) {
  const { data, error } = await getSupabase().storage
    .from(BUCKET)
    .createSignedUrl(path, expiresIn);

  if (error) {
    throw error;
  }

  return data.signedUrl;
}

export async function downloadFile(path) {
  if (!BUCKET) throw new Error("Supabase Storage is not configured. Set SUPABASE_STORAGE_BUCKET on the backend.");
  const { data, error } = await getSupabase().storage.from(BUCKET).download(path);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}
