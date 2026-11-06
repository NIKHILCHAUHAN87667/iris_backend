# IRIS API

## Clerk-to-IRIS account sync

The API uses Clerk session tokens for `GET /api/users/me`. Employee UI routes remain blocked until this endpoint finds an active `users` row. If the row is missing and the signed-in Clerk email matches an existing IRIS roster row, the endpoint links that row to the Clerk ID. It never creates a new account from a browser request.

New rows are created only by the signature-verified Clerk `user.created` webhook. Invited users remain `pending` after signup until an administrator approves them. Department is read from Clerk `public_metadata.department_id` or `public_metadata.department`, then falls back to `DEFAULT_DEPARTMENT_ID`. If there is exactly one active department, the service uses it automatically. It fails the webhook (so Clerk retries) if department assignment is ambiguous or no active department exists.

## Configure

1. Copy the values you need from `.env.example` into `Backend/.env` without replacing existing database or Supabase secrets. Set `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`, a long random `ADMIN_SESSION_SECRET`, `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`, `QDRANT_URL`, `QDRANT_API_KEY`, `FRONTEND_ORIGIN`, and `FRONTEND_URL`. Create a **private** Supabase Storage bucket with the same name as `SUPABASE_STORAGE_BUCKET` (the example uses `iris-documents`). Never expose service-role or Qdrant API keys to the frontend. Qdrant ingestion uses Qdrant Cloud Inference for dense vectors and BM25 sparse vectors; configure the model names with `QDRANT_DENSE_MODEL` and `QDRANT_SPARSE_MODEL` if needed. The collection is created automatically on the first indexing job. Get both Clerk API keys from the Clerk Dashboard's **API keys** page. The demo admin defaults are `admin` / `irisadmin123`; override them with `DEMO_ADMIN_USERNAME` and `DEMO_ADMIN_PASSWORD`. Never use these demo defaults in production.
2. Apply `prisma/migrations/20261006090000_add_clerk_user_id/migration.sql` to the existing PostgreSQL database once (for example, in the Supabase SQL editor). This repository has no previous Prisma migration history, so the additive SQL is provided for the existing schema. Then regenerate the client with `npx prisma generate`.
3. In Clerk, set the application access mode to **Invite-only / Restricted**. Create a webhook endpoint at `https://<api-host>/api/webhooks/clerk` and subscribe it to `user.created`, `user.updated`, and `user.deleted`. Copy its signing secret to `CLERK_WEBHOOK_SIGNING_SECRET`.
4. Set `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_API_BASE_URL` in `Frontend/.env`, then start both processes:

   ```powershell
   # terminal 1
   cd Backend
   npm run dev

   # terminal 2
   cd Frontend
   npm run dev
   ```

The webhook endpoint needs to be reachable by Clerk. For local development, use a secure tunnel and set the Clerk endpoint URL to the tunnel URL plus `/api/webhooks/clerk`.

The admin sign-in endpoint creates a short-lived HttpOnly, SameSite=Strict cookie signed with `ADMIN_SESSION_SECRET`. User management endpoints require this cookie. The admin demo credentials are server-side only; they must be replaced with real administrator identity and authorization before production.

## API

- `GET /api/health` — process health check.
- `GET /api/admin/departments` and `POST /api/admin/departments` — require the demo admin session; list active departments and create or reactivate departments for employee invitations.
- `POST /api/admin/users/:userId/approve` — requires the demo admin session; activates an invited user after Clerk signup has linked their account.
- `GET /api/admin/documents` — requires the demo admin session; lists uploaded documents for monitoring and review.
- `GET /api/admin/documents/:documentId/download` — requires the demo admin session; creates a short-lived review link.
- `POST /api/admin/documents/:documentId/review` — requires the demo admin session; approve or reject pending uploads and grant extra department access.
- `GET /api/admin/access-requests` and `POST /api/admin/access-requests/:requestId/review` — require the demo admin session; list employee requests and approve or reject department access.
- `GET /api/admin/ingestion` and `POST /api/admin/ingestion/:documentId` — require the demo admin session; show Qdrant connection and ingestion jobs, and index/reindex approved documents using dense and BM25 vectors with department/user access metadata.
- `GET /api/users/me` — requires `Authorization: Bearer <Clerk session token>`; returns the linked active IRIS user, or `403 ACCOUNT_NOT_REGISTERED` / `403 ACCOUNT_NOT_ACTIVE`.
- `POST /api/documents/upload` — requires an active Clerk user; stores a PDF, DOCX, PPTX, XLSX, or TXT (up to 20 MB) in private Supabase Storage and creates a pending review record for the uploader's department.
- `GET /api/documents` — requires an active Clerk user; lists approved documents in their own or explicitly granted departments.
- `POST /api/documents/search` — requires an active Clerk user; searches approved indexed documents across departments, returns metadata for restricted matches without snippets, and rechecks current database permissions before returning document text.
- `POST /api/documents/assistant/explain` — requires an active Clerk user and `GROQ_API_KEY`; rechecks current access, retrieves the selected Qdrant passages, and uses `openai/gpt-oss-20b` to return a grounded summary and explanation.
- `GET /api/documents/:documentId/download` — requires an active Clerk user with access; returns a five-minute signed URL.
- `GET /api/documents/:documentId/access-info` and `POST /api/documents/:documentId/access-requests` — require an active Clerk user; show restricted-link request status and submit a reason for a department access request.
- `POST /api/webhooks/clerk` — public network endpoint, but each event is verified with Clerk's webhook signing secret before it can update the database.
- `POST /api/admin/users/invitations` — requires the demo admin session; creates a pending IRIS roster row and a Clerk invitation email with department, role, employee code, and title metadata.

The old roster rows must have `status = active` to pass the account gate. New invitations remain pending after the verified Clerk `user.created` webhook links the account. An administrator must approve the linked row in User Management before the employee can access IRIS.

Employee uploads are private and unavailable to employees until approved. Approval grants access to the document's owning department and any additional active departments selected by the administrator. File downloads are issued as short-lived signed URLs after the API checks the user's department grants.

Search can discover any approved, indexed document across departments. For documents outside the employee's current grants, it returns limited metadata only (no content excerpt or download) and provides an access request action; submitted requests appear in the admin Access Requests queue. The API checks the current PostgreSQL grants before returning any document content or issuing a download link.

The admin Ingestion Monitor extracts text from approved PDF, DOCX, PPTX, XLSX, and TXT uploads, splits it into overlapping chunks, and stores each chunk in the configured Qdrant collection with dense and BM25 vectors. Scanned PDFs without an embedded text layer need OCR before ingestion. The document's owning department, granted departments, and explicitly granted user IDs are included in point payloads so the search API can apply authorization filters.
