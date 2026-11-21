// One-time migration from the original FixMate shape to the assignment shape.
// Safe to run more than once: every step checks whether it already ran.
//
// Run from the server folder:
//   node --env-file=.env scripts/migrate.js
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI);

const TECHNICIANS = {
  TECHNICIAN_ID_1: {
    id: "6afeac491f650fc35db69a7d",
    name: "Shoayeb",
    email: "shoayeb@gmail.com",
    area: "Dhaka, Bangladesh",
  },
  TECHNICIAN_ID_2: {
    id: "6afeb1fa1f650fc35db69a8a",
    name: "Challu Vai",
    email: "challu@gmail.com",
    area: "Dhaka, Bangladesh",
  },
};

function categoryFor(title) {
  const value = String(title ?? "").toLowerCase();

  if (value.includes("smartphone") || value.includes("mobile") || value.includes("iphone")) {
    return "Smartphone";
  }
  if (value.includes("laptop") || value.includes("computer") || value.includes("pc")) {
    return "Laptop & PC";
  }
  if (value.includes("air conditioner") || value.includes(" ac ") || value.endsWith(" ac")) {
    return "AC";
  }
  if (value.includes("refrigerator") || value.includes("fridge")) {
    return "Refrigerator";
  }
  if (value.includes("television") || value.includes(" tv")) {
    return "TV";
  }
  if (value.includes("washing machine")) {
    return "Washing Machine";
  }
  if (value.includes("electrical") || value.includes("wiring")) {
    return "Electrical";
  }

  return null;
}

function modeFor(category) {
  if (category === "Smartphone" || category === "Laptop & PC" || category === "TV") {
    return "Shop Drop-off";
  }
  return "Home Visit";
}

function slugFor(title) {
  return String(title ?? "service")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
}

function statusHistoryFor(booking) {
  const when = booking.createdAt || new Date().toISOString();
  const status = String(booking.status ?? "requested").toLowerCase().replaceAll(" ", "-");
  const history = [{ status: "requested", changedAt: when }];

  if (["accepted", "in-progress", "completed"].includes(status)) {
    history.push({ status: "accepted", changedAt: when });
  }
  if (["in-progress", "completed"].includes(status)) {
    history.push({ status: "in-progress", changedAt: when });
  }
  if (status === "completed") {
    history.push({ status: "completed", changedAt: when });
  }
  if (status === "rejected" || status === "cancelled") {
    history.push({ status, changedAt: when });
  }
  if (booking.paymentStatus === "paid") {
    history.push({ status: "paid", changedAt: when });
  }

  return history;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing. Add it to the server .env file.");
  }

  await client.connect();
  const db = client.db("fixmate");

  const users = db.collection("user");
  const services = db.collection("services");
  const bookings = db.collection("bookings");
  const oldTransactions = db.collection("transactions");
  const payments = db.collection("payments");

  // 1. Users: rename serviceArea -> area and give technicians a service area.
  const allUsers = await users.find({}).toArray();
  for (const user of allUsers) {
    const updates = {};

    if (user.serviceArea !== undefined && user.area === undefined) {
      updates.area = user.serviceArea;
    }
    if (user.role === "technician" && !user.area) {
      updates.area = "Dhaka, Bangladesh";
    }

    if (Object.keys(updates).length > 0) {
      await users.updateOne(
        { _id: user._id },
        { $set: updates, $unset: { serviceArea: "" } }
      );
    }
  }

  // 2. Services: fix technician ids, map categories, rename fields.
  const allServices = await services.find({}).toArray();
  const serviceById = new Map(allServices.map((service) => [String(service._id), service]));
  const deletedServiceIds = [];

  for (const service of allServices) {
    const placeholder = TECHNICIANS[service.technicianId];
    let technician = placeholder;

    if (!technician) {
      const owner = allUsers.find((user) => String(user._id) === String(service.technicianId));
      if (owner) {
        technician = {
          id: String(owner._id),
          name: owner.name,
          email: owner.email,
          area: owner.area || "Dhaka, Bangladesh",
        };
      }
    }

    const category = categoryFor(service.title) || service.category;
    const allowed = [
      "Smartphone",
      "Laptop & PC",
      "AC",
      "Refrigerator",
      "TV",
      "Washing Machine",
      "Electrical",
    ];

    if (!allowed.includes(category)) {
      // The old catalogue contained plumbing/painting/cleaning entries that do
      // not belong to the assignment's seven categories. Keep the booking
      // history (it stores a copy) and remove the service listing.
      deletedServiceIds.push(String(service._id));
      continue;
    }

    const basePrice =
      typeof service.basePrice === "number"
        ? service.basePrice
        : typeof service.price === "number"
          ? service.price
          : 0;

    const image = service.image || service.thumbnail || "";

    const updates = {
      title: service.title,
      slug: service.slug || slugFor(service.title),
      description:
        service.description ||
        `Professional ${service.title.toLowerCase()} by a verified FixMate technician.`,
      category,
      basePrice,
      estimatedDuration: service.estimatedDuration || "1-2 hours",
      image,
      images: Array.isArray(service.images) ? service.images : [],
      technicianId: technician?.id || service.technicianId,
      technicianName: technician?.name || service.technicianName || "FixMate technician",
      technicianEmail: technician?.email || service.technicianEmail || "",
      serviceArea: technician?.area || service.serviceArea || service.location || "Dhaka, Bangladesh",
      serviceMode: service.serviceMode || modeFor(category),
      approvalStatus: service.approvalStatus || "approved",
      isAvailable:
        typeof service.isAvailable === "boolean"
          ? service.isAvailable
          : service.isActive !== false,
      createdAt: service.createdAt || new Date().toISOString(),
    };

    await services.updateOne(
      { _id: service._id },
      {
        $set: updates,
        $unset: {
          price: "",
          thumbnail: "",
          isActive: "",
          location: "",
          serviceType: "",
          mode: "",
        },
      }
    );
  }

  if (deletedServiceIds.length > 0) {
    const ids = deletedServiceIds.map((id) => toObjectId(id));
    await services.deleteMany({ _id: { $in: ids } });
    console.log(`Removed ${deletedServiceIds.length} service(s) outside the seven categories`);
  }

  // 3. Bookings: rename fields, copy service details, normalize status.
  const allBookings = await bookings.find({}).toArray();

  for (const booking of allBookings) {
    const service = serviceById.get(String(booking.serviceId));
    const placeholder = TECHNICIANS[booking.technicianId];
    let technician = placeholder;

    if (!technician && booking.technicianId) {
      const owner = allUsers.find((user) => String(user._id) === String(booking.technicianId));
      if (owner) {
        technician = {
          id: String(owner._id),
          name: owner.name,
          email: owner.email,
        };
      }
    }

    const basePrice =
      typeof booking.basePrice === "number"
        ? booking.basePrice
        : typeof booking.amount === "number"
          ? booking.amount
          : typeof service?.basePrice === "number"
            ? service.basePrice
            : typeof service?.price === "number"
              ? service.price
              : 0;

    const status = String(booking.status ?? "requested").toLowerCase().replaceAll(" ", "-");

    const updates = {
      serviceTitle: booking.serviceTitle || service?.title || "Repair service",
      serviceImage: booking.serviceImage || service?.image || service?.thumbnail || "",
      category: booking.category || service?.category || "Electrical",
      basePrice,
      finalAmount:
        typeof booking.finalAmount === "number"
          ? booking.finalAmount
          : typeof booking.amount === "number"
            ? booking.amount
            : basePrice,
      technicianId: technician?.id || booking.technicianId || "",
      technicianName: technician?.name || booking.technicianName || service?.technicianName || "",
      technicianEmail:
        technician?.email || booking.technicianEmail || service?.technicianEmail || "",
      address: booking.address || booking.customerAddress || "",
      problemDescription:
        booking.problemDescription || booking.notes || "Repair request submitted by the customer.",
      preferredDate: booking.preferredDate || "",
      status,
      paymentStatus: booking.paymentStatus || "unpaid",
      statusHistory: Array.isArray(booking.statusHistory)
        ? booking.statusHistory
        : statusHistoryFor({ ...booking, status }),
      createdAt: booking.createdAt || new Date().toISOString(),
    };

    await bookings.updateOne(
      { _id: booking._id },
      {
        $set: updates,
        $unset: { customerAddress: "", notes: "", amount: "" },
      }
    );
  }

  // 4. Transactions -> payments.
  const transactions = await oldTransactions.find({}).toArray();
  for (const transaction of transactions) {
    const booking = await bookings.findOne({ _id: toObjectId(transaction.bookingId) });
    const paidAt = transaction.createdAt || new Date().toISOString();

    const payment = {
      bookingId: String(transaction.bookingId ?? ""),
      serviceTitle: booking?.serviceTitle || "Repair service",
      customerId: transaction.customerId || booking?.customerId || "",
      customerName: transaction.customerName || booking?.customerName || "",
      customerEmail: booking?.customerEmail || "",
      technicianId: booking?.technicianId || "",
      technicianName: transaction.technicianName || booking?.technicianName || "",
      technicianEmail: booking?.technicianEmail || "",
      amount: transaction.amount ?? booking?.finalAmount ?? 0,
      currency: "bdt",
      transactionId:
        transaction.reference ||
        transaction.stripeSessionId ||
        `FIX-${String(transaction._id)}`,
      stripeSessionId: transaction.stripeSessionId || "",
      paymentStatus: "paid",
      paidAt,
      createdAt: paidAt,
    };

    if (payment.stripeSessionId) {
      await payments.updateOne(
        { stripeSessionId: payment.stripeSessionId },
        { $setOnInsert: payment },
        { upsert: true }
      );
    } else {
      await payments.updateOne(
        { transactionId: payment.transactionId },
        { $setOnInsert: payment },
        { upsert: true }
      );
    }
  }

  // 5. Indexes used by the new API.
  await payments.createIndex(
    { stripeSessionId: 1 },
    { unique: true, partialFilterExpression: { stripeSessionId: { $type: "string" } } }
  );
  await payments.createIndex({ bookingId: 1 });
  await payments.createIndex({ customerEmail: 1 });
  await payments.createIndex({ technicianEmail: 1 });
  await bookings.createIndex({ serviceId: 1 });
  await bookings.createIndex({ customerEmail: 1 });
  await bookings.createIndex({ technicianEmail: 1 });
  await services.createIndex({ approvalStatus: 1, isAvailable: 1 });
  await services.createIndex({ category: 1 });
  await services.createIndex({ serviceMode: 1 });

  // The assignment uses a payments collection, not transactions.
  await oldTransactions.drop().catch(() => {});

  console.log(`Migrated ${allUsers.length} users, ${allServices.length} services, ${allBookings.length} bookings`);
  console.log(`Created ${transactions.length} payment record(s)`);
}

function toObjectId(value) {
  try {
    return new ObjectId(String(value));
  } catch {
    return value;
  }
}

main()
  .catch((error) => {
    console.error("Migration failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close();
  });
