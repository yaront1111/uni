# ADR 0005: S3 transport and encryption boundary

Date: 2026-09-14
Status: Accepted implementation detail under CRT-SEC-08-A

Use the AWS S3 SDK against an HTTPS S3-compatible endpoint. Require bucket default
SSE-KMS encryption with an explicit key identifier, and repeat that encryption
requirement on every upload. Refuse initialization if bucket encryption differs.
The deployment principal must configure the bucket policy to deny insecure
transport and uploads without the required encryption key. KMS credentials and
provider credentials belong in the deployment secrets/identity system.

Public UUIDs and private storage keys are separate. The provider requires a
resolver that authorizes the authenticated actor, owner, purpose, public object
ID and requested operation before returning the private key. That resolver will
be composed by the evidence service using its owner-scoped source_items rows;
no new evidence table or public upload screen is added in this foundation node.
Storage exceptions are mapped to fixed codes without provider messages or keys.

SDK tests do not prove a deployed bucket is encrypted. Deployment verification
must supply real bucket/KMS policy and encryption evidence before Phase 0 exits.
