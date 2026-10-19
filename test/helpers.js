// Test helpers. With TEST_DATABASE_URL set, every test file starts from an empty PostgreSQL schema
// (the files run one after another; see "test" in package.json).
export async function freshDatabase() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return undefined;
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  return url;
}
