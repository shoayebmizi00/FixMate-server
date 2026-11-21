import "dotenv/config";
import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI);

const categories = [
  "Smartphone",
  "Laptop & PC",
  "AC",
  "Refrigerator",
  "TV",
  "Washing Machine",
  "Electrical",
];

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing.");
  }

  await client.connect();
  const db = client.db("fixmate");
  const users = db.collection("user");
  const services = db.collection("services");
  const bookings = db.collection("bookings");
  const payments = db.collection("payments");

  const technicians = await users
    .find({ role: "technician" })
    .limit(2)
    .toArray();

  if (technicians.length < 2) {
    throw new Error("Create at least two technician accounts before seeding.");
  }

  const customer = await users.findOne({ role: "customer" });
  if (!customer) {
    throw new Error("Create at least one customer account before seeding.");
  }

  const names = [
    "Screen Replacement",
    "Laptop Diagnostics",
    "AC Deep Cleaning",
    "Refrigerator Repair",
    "TV Board Repair",
    "Washing Machine Service",
    "Electrical Wiring",
    "Battery Replacement",
    "Laptop Fan Cleaning",
    "AC Gas Refill",
    "Refrigerator Cooling Fix",
    "Display Replacement",
  ];

  for (let index = 0; index < names.length; index += 1) {
    const technician = technicians[index % technicians.length];
    const category = categories[index % categories.length];
    const title = names[index];
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    await services.updateOne(
      { slug },
      {
        $set: {
          title,
          slug,
          description: `Professional ${title.toLowerCase()} by a verified FixMate technician.`,
          category,
          basePrice: [450, 650, 800, 900, 1200, 1500][index % 6],
          estimatedDuration: index % 2 === 0 ? "2-3 hours" : "1 day",
          image: "",
          technicianId: String(technician._id),
          technicianName: technician.name,
          technicianEmail: technician.email,
          serviceArea: technician.area || "Dhaka, Bangladesh",
          serviceMode: index % 2 === 0 ? "Home Visit" : "Shop Drop-off",
          approvalStatus: "approved",
          isAvailable: true,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
  }

  const service = await services.findOne({ approvalStatus: "approved", isAvailable: true });
  if (!service) throw new Error("No approved service was found.");

  const technician = technicians[0];
  const statuses = [
    "requested",
    "accepted",
    "in-progress",
    "completed",
    "rejected",
    "cancelled",
  ];

  for (const status of statuses) {
    const now = new Date().toISOString();
    const filter = { seedStatus: status };
    const history = [{ status: "requested", changedAt: now }];

    if (["accepted", "in-progress", "completed"].includes(status)) {
      history.push({ status: "accepted", changedAt: now });
    }
    if (["in-progress", "completed"].includes(status)) {
      history.push({ status: "in-progress", changedAt: now });
    }
    if (status === "completed") {
      history.push({ status: "completed", changedAt: now });
    }
    if (status === "rejected" || status === "cancelled") {
      history.push({ status, changedAt: now });
    }

    await bookings.updateOne(
      filter,
      {
        $set: {
          seedStatus: status,
          serviceId: String(service._id),
          serviceTitle: service.title,
          serviceImage: service.image || "",
          category: service.category,
          basePrice: service.basePrice,
          finalAmount: status === "completed" ? service.basePrice : 0,
          technicianId: String(technician._id),
          technicianName: technician.name,
          technicianEmail: technician.email,
          customerId: String(customer._id),
          customerName: customer.name,
          customerEmail: customer.email,
          customerPhone: "01700000000",
          address: "Dhaka, Bangladesh",
          preferredDate: new Date().toISOString().slice(0, 10),
          problemDescription: `Test ${status} repair booking created by the seed script.`,
          status,
          paymentStatus: "unpaid",
          statusHistory: history,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
  }

  const completed = await bookings.findOne({ seedStatus: "completed" });
  if (completed) {
    await payments.updateOne(
      { bookingId: String(completed._id) },
      {
        $setOnInsert: {
          bookingId: String(completed._id),
          serviceTitle: completed.serviceTitle,
          customerId: completed.customerId,
          customerName: completed.customerName,
          customerEmail: completed.customerEmail,
          technicianId: completed.technicianId,
          technicianName: completed.technicianName,
          technicianEmail: completed.technicianEmail,
          amount: completed.finalAmount,
          currency: "bdt",
          transactionId: "SEED-TEST-PAYMENT",
          stripeSessionId: "SEED-TEST-SESSION",
          paymentStatus: "paid",
          paidAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      },
      { upsert: true }
    );
    await bookings.updateOne(
      { _id: completed._id },
      { $set: { paymentStatus: "paid" } }
    );
  }

  await payments.createIndex(
    { stripeSessionId: 1 },
    { unique: true, partialFilterExpression: { stripeSessionId: { $type: "string" } } }
  );

  console.log("Seeded 12 services and bookings in multiple statuses.");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close();
  });
