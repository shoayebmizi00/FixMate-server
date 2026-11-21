import "dotenv/config";
import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI);

async function main() {
  await client.connect();
  const db = client.db("fixmate");

  const users = await db.collection("user").find({}).project({ name: 1, email: 1, role: 1, serviceArea: 1, area: 1 }).toArray();
  console.log("USERS");
  for (const user of users) console.log(JSON.stringify(user));

  const services = await db.collection("services").find({}).project({ title: 1, category: 1, price: 1, isActive: 1, technicianId: 1, technicianName: 1, location: 1, serviceMode: 1 }).toArray();
  console.log("SERVICES");
  for (const service of services) console.log(JSON.stringify(service));

  const bookings = await db.collection("bookings").find({}).project({ serviceTitle: 1, status: 1, paymentStatus: 1, amount: 1, customerEmail: 1, technicianId: 1 }).toArray();
  console.log("BOOKINGS");
  for (const booking of bookings) console.log(JSON.stringify(booking));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close();
  });
