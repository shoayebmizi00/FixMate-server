import "dotenv/config";
import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI);

async function main() {
  await client.connect();
  const db = client.db("fixmate");

  const service = await db.collection("services").findOne({ title: "Refrigerator Repair" });
  console.log("SERVICE SAMPLE", JSON.stringify(service, null, 2));

  const booking = await db.collection("bookings").findOne({ serviceTitle: "Refrigerator Repair" });
  console.log("BOOKING SAMPLE", JSON.stringify(booking, null, 2));

  const transaction = await db.collection("transactions").findOne({});
  console.log("TRANSACTION SAMPLE", JSON.stringify(transaction, null, 2));

  const user = await db.collection("user").findOne({ role: "technician" });
  console.log("TECH USER SAMPLE", JSON.stringify(user, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close();
  });
