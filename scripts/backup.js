// Creates a JSON backup of the FixMate data collections.
// Run from the server folder: node --env-file=.env scripts/backup.js
import "dotenv/config";
import { MongoClient } from "mongodb";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const client = new MongoClient(process.env.MONGODB_URI);

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing. Add it to the server .env file.");
  }

  await client.connect();
  const db = client.db("fixmate");
  const folder = join(process.cwd(), "backups", new Date().toISOString().replace(/[:.]/g, "-"));

  await mkdir(folder, { recursive: true });

  for (const name of ["user", "services", "bookings", "transactions"]) {
    const documents = await db.collection(name).find({}).toArray();
    await writeFile(join(folder, `${name}.json`), JSON.stringify(documents, null, 2), "utf8");
    console.log(`Saved ${documents.length} ${name} documents`);
  }

  console.log(`Backup written to ${folder}`);
}

main()
  .catch((error) => {
    console.error("Backup failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close();
  });
