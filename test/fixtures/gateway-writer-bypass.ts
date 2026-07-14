// Deliberate violations consumed only by test/guards/gateway-writers.test.ts.
// This fixture proves the guard catches quoted and schema-qualified raw SQL.
export const bypassAttempts = [
  `UPDATE public.gateway_connections SET enabled=false`,
  `INSERT INTO "gateway_resolution_leases" (lease_hash) VALUES ('x')`,
  `DELETE FROM "public"."gateway_audit_log" WHERE true`,
];
