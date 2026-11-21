import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import { webcrypto } from "node:crypto";

const app = express();

// Only the deployed client (and localhost in development) may call this API.
// The Next.js server calls it server-to-server, so no browser origin is sent.
const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed by CORS."));
    },
  })
);
app.use(express.json());

let jwksCache = null;
let jwksCachedAt = 0;

function decodeJwtPart(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "="
  );
  return Buffer.from(padded, "base64");
}

async function loadJwtKeys() {
  const now = Date.now();
  if (jwksCache && now - jwksCachedAt < 5 * 60 * 1000) return jwksCache;

  const authUrl = (
    process.env.CLIENT_URL ||
    process.env.BETTER_AUTH_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");

  const response = await fetch(`${authUrl}/api/auth/jwks`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load BetterAuth JWKS: ${response.status}`);
  }

  const jwks = await response.json();
  if (!Array.isArray(jwks.keys)) {
    throw new Error("BetterAuth JWKS response is invalid.");
  }

  jwksCache = jwks.keys;
  jwksCachedAt = now;
  return jwksCache;
}

async function verifyBetterAuthToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = JSON.parse(decodeJwtPart(encodedHeader).toString("utf8"));
  const payload = JSON.parse(decodeJwtPart(encodedPayload).toString("utf8"));

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) return null;

  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const expectedAudience =
    process.env.CLIENT_URL ||
    process.env.AUTH_API_URL ||
    "http://localhost:3000";
  if (payload.aud && !audience.includes(expectedAudience)) return null;

  const keys = await loadJwtKeys();
  const key = keys.find((item) => !header.kid || item.kid === header.kid) || keys[0];
  if (!key) return null;

  const algorithm =
    key.kty === "OKP"
      ? { name: "Ed25519" }
      : key.kty === "EC"
        ? { name: "ECDSA", namedCurve: key.crv }
        : null;
  if (!algorithm) return null;

  const publicKey = await webcrypto.subtle.importKey(
    "jwk",
    key,
    algorithm,
    false,
    ["verify"]
  );
  const signedData = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = decodeJwtPart(encodedSignature);
  const valid = await webcrypto.subtle.verify(
    algorithm,
    publicKey,
    signature,
    signedData
  );

  return valid ? payload : null;
}

async function verifyToken(req, res, next) {
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (
    internalSecret &&
    req.headers["x-fixmate-internal-secret"] === internalSecret
  ) {
    req.user = {
      sub: text(req.body?.customerId) || "stripe",
      role: "customer",
      email: text(req.body?.customerEmail) || "",
      internal: true,
    };
    next();
    return;
  }

  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    res.status(401).send({ error: "Unauthorized." });
    return;
  }

  try {
    const payload = await verifyBetterAuthToken(authorization.slice(7).trim());
    if (!payload?.sub) {
      res.status(401).send({ error: "Invalid or expired token." });
      return;
    }
    req.user = payload;
    next();
  } catch (error) {
    console.error("JWT verification error:", error);
    res.status(401).send({ error: "Unauthorized." });
  }
}

function verifyCustomer(req, res, next) {
  if (req.user?.role !== "customer") {
    res.status(403).send({ error: "Forbidden." });
    return;
  }
  next();
}

function verifyTechnician(req, res, next) {
  if (req.user?.role !== "technician") {
    res.status(403).send({ error: "Forbidden." });
    return;
  }
  next();
}

function verifyAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    res.status(403).send({ error: "Forbidden." });
    return;
  }
  next();
}

const client = new MongoClient(process.env.MONGODB_URI);
let clientPromise;

async function connectToMongoDB() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing!");
  }

  if (!clientPromise) {
    clientPromise = client.connect();
  }

  return clientPromise;
}

async function getCollections() {
  const connectedClient = await connectToMongoDB();
  const db = connectedClient.db("fixmate");

  return {
    users: db.collection("user"),
    services: db.collection("services"),
    bookings: db.collection("bookings"),
    payments: db.collection("payments"),
  };
}

const SERVICE_CATEGORIES = [
  "Smartphone",
  "Laptop & PC",
  "AC",
  "Refrigerator",
  "TV",
  "Washing Machine",
  "Electrical",
];

const SERVICE_MODES = ["Home Visit", "Shop Drop-off"];

const BOOKING_STATUSES = [
  "requested",
  "accepted",
  "rejected",
  "in-progress",
  "completed",
  "cancelled",
];

const ALLOWED_TRANSITIONS = {
  requested: ["accepted", "rejected", "cancelled"],
  accepted: ["in-progress"],
  "in-progress": ["completed"],
  completed: [],
  rejected: [],
  cancelled: [],
};

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function number(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toObjectId(value) {
  try {
    return new ObjectId(String(value));
  } catch {
    return null;
  }
}

function serviceFilter(value) {
  const objectId = toObjectId(value);
  return objectId ? { $or: [{ _id: objectId }, { slug: value }] } : { slug: value };
}

function normalizeStatus(value) {
  return text(value).toLowerCase().replaceAll(" ", "-");
}

function serviceResponse(service) {
  return {
    ...service,
    _id: String(service._id),
    basePrice: number(service.basePrice),
    image: service.image || "",
    isAvailable: service.isAvailable !== false,
    approvalStatus: service.approvalStatus || "pending",
  };
}

function bookingResponse(booking) {
  return {
    ...booking,
    _id: String(booking._id),
    basePrice: number(booking.basePrice),
    finalAmount: number(booking.finalAmount),
    statusHistory: Array.isArray(booking.statusHistory) ? booking.statusHistory : [],
  };
}

function paymentResponse(payment) {
  return {
    ...payment,
    _id: String(payment._id),
    amount: number(payment.amount),
    paymentStatus: "paid",
  };
}

// Home route
app.get("/", (req, res) => {
  res.send({ message: "FixMate server is running!" });
});

// Get all users. Optional ?role=technician.
app.get("/users", async (req, res) => {
  try {
    const { users } = await getCollections();
    const filter = {};

    if (req.query.role) {
      filter.role = text(req.query.role);
    }

    const allUsers = await users.find(filter).toArray();
    res.status(200).send(allUsers.map((user) => ({ ...user, _id: String(user._id) })));
  } catch (err) {
    console.error("Users error:", err);
    res.status(500).send({ error: "An error occurred while fetching users." });
  }
});

// Get one user.
app.get("/users/:id", async (req, res) => {
  try {
    const { users } = await getCollections();
    const id = toObjectId(req.params.id);

    if (!id) {
      res.status(400).send({ error: "Invalid user id." });
      return;
    }

    const user = await users.findOne({ _id: id });

    if (!user) {
      res.status(404).send({ error: "User not found." });
      return;
    }

    res.status(200).send({ ...user, _id: String(user._id) });
  } catch (err) {
    console.error("User error:", err);
    res.status(500).send({ error: "An error occurred while fetching the user." });
  }
});

// Update a user (role, name, phone, area, bio or photo).
app.patch("/users/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { users } = await getCollections();
    const id = toObjectId(req.params.id);

    if (!id) {
      res.status(400).send({ error: "Invalid user id." });
      return;
    }

    const updates = { ...req.body, updatedAt: new Date() };
    delete updates._id;

    const result = await users.updateOne({ _id: id }, { $set: updates });
    res.status(200).send(result);
  } catch (err) {
    console.error("Update user error:", err);
    res.status(500).send({ error: "An error occurred while updating the user." });
  }
});

// List services with server-side search, filters, sorting and pagination.
// Public callers get approved + available services only. Admin/technician
// callers pass ?all=true to see every listing.
app.get("/services", async (req, res) => {
  try {
    const { services } = await getCollections();

    const search = text(req.query.search);
    const category = text(req.query.category);
    const mode = text(req.query.mode);
    const sort = text(req.query.sort) || "newest";
    const all = req.query.all === "true";
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || (all ? 100 : 12)));

    const filter = {};

    if (!all) {
      filter.approvalStatus = "approved";
      filter.isAvailable = true;
    } else if (req.query.approvalStatus) {
      filter.approvalStatus = text(req.query.approvalStatus);
    }

    if (category && category !== "all") {
      filter.category = category;
    }

    if (mode && mode !== "all") {
      filter.serviceMode = mode;
    }

    if (req.query.technicianId) {
      filter.technicianId = text(req.query.technicianId);
    }

    if (req.query.technicianEmail) {
      filter.technicianEmail = text(req.query.technicianEmail);
    }

    if (search) {
      const pattern = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ title: pattern }, { category: pattern }];
    }

    const sortOption =
      sort === "price-asc"
        ? { basePrice: 1, createdAt: -1 }
        : sort === "price-desc"
          ? { basePrice: -1, createdAt: -1 }
          : sort === "title"
            ? { title: 1 }
            : { createdAt: -1 };

    const total = await services.countDocuments(filter);
    const pages = Math.max(1, Math.ceil(total / limit));

    const items = await services
      .find(filter)
      .sort(sortOption)
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    res.status(200).send({
      services: items.map(serviceResponse),
      total,
      page,
      pages,
      limit,
    });
  } catch (err) {
    console.error("Services error:", err);
    res.status(500).send({ error: "An error occurred while fetching services." });
  }
});

// Get one service by id or slug.
app.get("/services/:id", async (req, res) => {
  try {
    const { services } = await getCollections();
    const service = await services.findOne(serviceFilter(req.params.id));

    if (!service) {
      res.status(404).send({ error: "Service not found." });
      return;
    }

    res.status(200).send(serviceResponse(service));
  } catch (err) {
    console.error("Service error:", err);
    res.status(500).send({ error: "An error occurred while fetching the service." });
  }
});

// Create a new service. New listings always start pending and available.
app.post("/services", verifyToken, verifyTechnician, async (req, res) => {
  try {
    const { services } = await getCollections();
    const body = req.body;

    if (!text(body.title) || !text(body.description)) {
      res.status(400).send({ error: "Title and description are required." });
      return;
    }

    if (number(body.basePrice) <= 0) {
      res.status(400).send({ error: "Enter a price greater than zero." });
      return;
    }

    if (!SERVICE_CATEGORIES.includes(body.category)) {
      res.status(400).send({ error: "Choose a valid service category." });
      return;
    }

    if (!SERVICE_MODES.includes(body.serviceMode)) {
      res.status(400).send({ error: "Choose a valid service mode." });
      return;
    }

    const service = {
      title: text(body.title),
      slug: text(body.slug),
      description: text(body.description),
      category: body.category,
      basePrice: number(body.basePrice),
      estimatedDuration: text(body.estimatedDuration) || "1-2 hours",
      image: text(body.image),
      images: Array.isArray(body.images) ? body.images : [],
      technicianId: text(body.technicianId),
      technicianName: text(body.technicianName),
      technicianEmail: text(body.technicianEmail),
      serviceArea: text(body.serviceArea) || "Dhaka, Bangladesh",
      serviceMode: body.serviceMode,
      approvalStatus: "pending",
      isAvailable: true,
      createdAt: new Date().toISOString(),
    };

    const result = await services.insertOne(service);
    res.status(201).send({ ...service, _id: String(result.insertedId) });
  } catch (err) {
    console.error("Create service error:", err);
    res.status(500).send({ error: "An error occurred while creating the service." });
  }
});

// Update a service. The Next.js layer decides who may send which fields.
app.patch("/services/:id", verifyToken, async (req, res) => {
  try {
    const { services } = await getCollections();
    if (!["technician", "admin"].includes(req.user.role)) {
      res.status(403).send({ error: "Forbidden." });
      return;
    }
    const existing = await services.findOne(serviceFilter(req.params.id));
    if (!existing) {
      res.status(404).send({ error: "Service not found." });
      return;
    }
    if (
      req.user.role === "technician" &&
      String(existing.technicianId) !== req.user.sub &&
      String(existing.technicianEmail).toLowerCase() !== String(req.user.email).toLowerCase()
    ) {
      res.status(403).send({ error: "You can only edit your own services." });
      return;
    }
    const filter = serviceFilter(req.params.id);
    const updates = { ...req.body, updatedAt: new Date() };

    delete updates._id;
    delete updates.slug;

    if (updates.basePrice !== undefined) {
      updates.basePrice = number(updates.basePrice);
    }
    if (updates.isAvailable !== undefined) {
      updates.isAvailable = Boolean(updates.isAvailable);
    }
    if (updates.approvalStatus !== undefined && !["pending", "approved", "rejected"].includes(updates.approvalStatus)) {
      res.status(400).send({ error: "Invalid approval status." });
      return;
    }
    if (updates.category !== undefined && !SERVICE_CATEGORIES.includes(updates.category)) {
      res.status(400).send({ error: "Choose a valid service category." });
      return;
    }
    if (updates.serviceMode !== undefined && !SERVICE_MODES.includes(updates.serviceMode)) {
      res.status(400).send({ error: "Choose a valid service mode." });
      return;
    }

    const result = await services.updateOne(filter, { $set: updates });

    if (result.matchedCount === 0) {
      res.status(404).send({ error: "Service not found." });
      return;
    }

    const updated = await services.findOne(filter);
    res.status(200).send(serviceResponse(updated));
  } catch (err) {
    console.error("Update service error:", err);
    res.status(500).send({ error: "An error occurred while updating the service." });
  }
});

// Delete a service. Bookings keep their copied service fields.
app.delete("/services/:id", verifyToken, async (req, res) => {
  try {
    const { services } = await getCollections();
    if (!["technician", "admin"].includes(req.user.role)) {
      res.status(403).send({ error: "Forbidden." });
      return;
    }
    const existing = await services.findOne(serviceFilter(req.params.id));
    if (!existing) {
      res.status(404).send({ error: "Service not found." });
      return;
    }
    if (
      req.user.role === "technician" &&
      String(existing.technicianId) !== req.user.sub &&
      String(existing.technicianEmail).toLowerCase() !== String(req.user.email).toLowerCase()
    ) {
      res.status(403).send({ error: "You can only delete your own services." });
      return;
    }
    const result = await services.deleteOne(serviceFilter(req.params.id));

    if (result.deletedCount === 0) {
      res.status(404).send({ error: "Service not found." });
      return;
    }

    res.status(200).send({ deleted: true });
  } catch (err) {
    console.error("Delete service error:", err);
    res.status(500).send({ error: "An error occurred while deleting the service." });
  }
});

// Get bookings. Optional filters keep the payload small.
app.get("/bookings", verifyToken, async (req, res) => {
  try {
    const { bookings } = await getCollections();
    const filter = {};

    if (req.user.internal) {
      // Internal Stripe webhook/success verification may read the booking.
    } else if (req.user.role === "customer") {
      filter.$or = [
        { customerId: req.user.sub },
        { customerEmail: req.user.email },
      ];
      delete req.query.customerEmail;
    } else if (req.user.role === "technician") {
      filter.$or = [
        { technicianId: req.user.sub },
        { technicianEmail: req.user.email },
      ];
    } else if (req.user.role !== "admin") {
      res.status(403).send({ error: "Forbidden." });
      return;
    }

    for (const field of ["customerEmail", "customerId", "technicianEmail", "technicianId"]) {
      if (req.query[field]) {
        filter[field] = text(req.query[field]);
      }
    }

    if (req.query.status) {
      filter.status = normalizeStatus(req.query.status);
    }

    const allBookings = await bookings.find(filter).sort({ createdAt: -1 }).toArray();
    res.status(200).send(allBookings.map(bookingResponse));
  } catch (err) {
    console.error("Get bookings error:", err);
    res.status(500).send({ error: "An error occurred while fetching bookings." });
  }
});

// Get one booking.
app.get("/bookings/:id", verifyToken, async (req, res) => {
  try {
    const { bookings } = await getCollections();
    const id = toObjectId(req.params.id);

    if (!id) {
      res.status(400).send({ error: "Invalid booking id." });
      return;
    }

    const booking = await bookings.findOne({ _id: id });

    if (!booking) {
      res.status(404).send({ error: "Booking not found." });
      return;
    }

    if (req.user.internal) {
      // Internal Stripe verification may read the booking.
    } else if (req.user.role === "customer") {
      const owns =
        String(booking.customerId) === req.user.sub ||
        String(booking.customerEmail).toLowerCase() === String(req.user.email).toLowerCase();
      if (!owns) {
        res.status(403).send({ error: "You can only view your own booking." });
        return;
      }
    } else if (req.user.role === "technician") {
      const owns =
        String(booking.technicianId) === req.user.sub ||
        String(booking.technicianEmail).toLowerCase() === String(req.user.email).toLowerCase();
      if (!owns) {
        res.status(403).send({ error: "You can only view your own booking." });
        return;
      }
    } else if (req.user.role !== "admin") {
      res.status(403).send({ error: "Forbidden." });
      return;
    }

    res.status(200).send(bookingResponse(booking));
  } catch (err) {
    console.error("Booking error:", err);
    res.status(500).send({ error: "An error occurred while fetching the booking." });
  }
});

// Create a new repair request. It always starts requested and unpaid.
app.post("/bookings", verifyToken, verifyCustomer, async (req, res) => {
  try {
    const { bookings } = await getCollections();
    const body = req.body;
    body.customerId = req.user.sub;
    body.customerEmail = req.user.email;

    if (!text(body.serviceId) || !text(body.customerEmail) || !text(body.customerName)) {
      res.status(400).send({ error: "Service and customer details are required." });
      return;
    }

    if (!text(body.customerPhone) || !text(body.address) || !text(body.preferredDate)) {
      res.status(400).send({ error: "Phone, address and preferred date are required." });
      return;
    }

    if (text(body.problemDescription).length < 20) {
      res.status(400).send({ error: "Describe the problem in at least 20 characters." });
      return;
    }

    if (
      text(body.technicianEmail).toLowerCase() ===
      text(body.customerEmail).toLowerCase()
    ) {
      res.status(403).send({
        error: "Technicians cannot request their own repair service.",
      });
      return;
    }

    const activeStatuses = ["requested", "accepted", "in-progress"];
    const duplicate = await bookings.findOne({
      serviceId: text(body.serviceId),
      customerEmail: text(body.customerEmail).toLowerCase(),
      status: { $in: activeStatuses },
    });

    if (duplicate) {
      res.status(409).send({
        error: "You already have an active request for this service.",
      });
      return;
    }

    const now = new Date().toISOString();
    const booking = {
      serviceId: text(body.serviceId),
      serviceTitle: text(body.serviceTitle),
      serviceImage: text(body.serviceImage),
      category: text(body.category),
      basePrice: number(body.basePrice),
      technicianId: text(body.technicianId),
      technicianName: text(body.technicianName),
      technicianEmail: text(body.technicianEmail),
      customerId: text(body.customerId),
      customerName: text(body.customerName),
      customerEmail: text(body.customerEmail),
      customerPhone: text(body.customerPhone),
      address: text(body.address),
      preferredDate: text(body.preferredDate),
      problemDescription: text(body.problemDescription),
      status: "requested",
      finalAmount: number(body.basePrice),
      paymentStatus: "unpaid",
      statusHistory: [{ status: "requested", changedAt: now }],
      createdAt: now,
    };

    const result = await bookings.insertOne(booking);
    res.status(201).send({ ...booking, _id: String(result.insertedId) });
  } catch (err) {
    console.error("Create booking error:", err);
    res.status(500).send({ error: "An error occurred while creating the booking." });
  }
});

// Update a booking. Only the allowed status transitions are accepted.
app.patch("/bookings/:id", verifyToken, async (req, res) => {
  try {
    const { bookings } = await getCollections();
    const id = toObjectId(req.params.id);

    if (!id) {
      res.status(400).send({ error: "Invalid booking id." });
      return;
    }

    const booking = await bookings.findOne({ _id: id });

    if (!booking) {
      res.status(404).send({ error: "Booking not found." });
      return;
    }

    const role = req.user.role;
    if (role === "admin") {
      res.status(403).send({ error: "Admins cannot change booking status." });
      return;
    }
    if (role === "customer") {
      const owns =
        String(booking.customerId) === req.user.sub ||
        String(booking.customerEmail).toLowerCase() === String(req.user.email).toLowerCase();
      const isPaymentUpdate =
        req.body.status === undefined &&
        text(req.body.paymentStatus) === "paid";
      if (!owns && !isPaymentUpdate) {
        res.status(403).send({ error: "You can only update your own booking." });
        return;
      }
      if (!isPaymentUpdate && text(req.body.status) !== "cancelled") {
        res.status(403).send({ error: "Customers may only cancel a booking." });
        return;
      }
    } else if (role === "technician") {
      const owns =
        String(booking.technicianId) === req.user.sub ||
        String(booking.technicianEmail).toLowerCase() === String(req.user.email).toLowerCase();
      if (!owns) {
        res.status(403).send({ error: "You can only update your own bookings." });
        return;
      }
    } else {
      res.status(403).send({ error: "Forbidden." });
      return;
    }

    const body = req.body;
    const currentStatus = normalizeStatus(booking.status);
    const nextStatus = body.status === undefined ? currentStatus : normalizeStatus(body.status);
    const updates = { updatedAt: new Date().toISOString() };

    if (body.status !== undefined) {
      if (!BOOKING_STATUSES.includes(nextStatus)) {
        res.status(400).send({ error: "Invalid booking status." });
        return;
      }

      if (nextStatus !== currentStatus) {
        const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];

        if (!allowed.includes(nextStatus)) {
          res.status(409).send({
            error: `A ${currentStatus} booking cannot become ${nextStatus}.`,
          });
          return;
        }

        if (nextStatus === "completed") {
          const finalAmount = number(body.finalAmount);

          if (finalAmount <= 0) {
            res.status(400).send({ error: "Enter a final amount greater than zero." });
            return;
          }

          updates.finalAmount = finalAmount;
        }

        const history = Array.isArray(booking.statusHistory) ? booking.statusHistory : [];
        updates.statusHistory = [
          ...history,
          { status: nextStatus, changedAt: new Date().toISOString() },
        ];
      }

      updates.status = nextStatus;
    }

    if (body.paymentStatus !== undefined) {
      if (body.paymentStatus !== "paid") {
        res.status(400).send({ error: "The only allowed payment status change is paid." });
        return;
      }

      if (normalizeStatus(booking.status) !== "completed") {
        res.status(409).send({ error: "Only completed bookings can be paid." });
        return;
      }

      if (booking.paymentStatus === "paid") {
        res.status(200).send(bookingResponse(booking));
        return;
      }

      updates.paymentStatus = "paid";
      const history = updates.statusHistory || (Array.isArray(booking.statusHistory) ? booking.statusHistory : []);
      updates.statusHistory = [
        ...history,
        { status: "paid", changedAt: new Date().toISOString() },
      ];
    }

    if (Array.isArray(body.statusHistory)) {
      updates.statusHistory = body.statusHistory;
    }

    await bookings.updateOne({ _id: id }, { $set: updates });
    const updated = await bookings.findOne({ _id: id });
    res.status(200).send(bookingResponse(updated));
  } catch (err) {
    console.error("Update booking error:", err);
    res.status(500).send({ error: "An error occurred while updating the booking." });
  }
});

// Get payments. Optional customer/technician filters.
app.get("/payments", verifyToken, async (req, res) => {
  try {
    const { payments } = await getCollections();
    const filter = {};

    if (req.user.role === "customer") {
      filter.$or = [
        { customerId: req.user.sub },
        { customerEmail: req.user.email },
      ];
    } else if (req.user.role === "technician") {
      filter.$or = [
        { technicianId: req.user.sub },
        { technicianEmail: req.user.email },
      ];
    } else if (req.user.role !== "admin") {
      res.status(403).send({ error: "Forbidden." });
      return;
    }

    for (const field of ["customerEmail", "customerId", "technicianEmail", "technicianId", "bookingId"]) {
      if (req.query[field]) {
        filter[field] = text(req.query[field]);
      }
    }

    const allPayments = await payments.find(filter).sort({ paidAt: -1 }).toArray();
    res.status(200).send(allPayments.map(paymentResponse));
  } catch (err) {
    console.error("Payments error:", err);
    res.status(500).send({ error: "An error occurred while fetching payments." });
  }
});

// Save a payment once. The unique stripeSessionId index plus this upsert make
// the success page and the Stripe webhook safe to run more than once.
app.post("/payments", verifyToken, verifyCustomer, async (req, res) => {
  try {
    const { payments, bookings } = await getCollections();
    const body = req.body;
    body.customerId = req.user.sub;
    body.customerEmail = req.user.email;
    const stripeSessionId = text(body.stripeSessionId);

    if (!stripeSessionId && !text(body.transactionId)) {
      res.status(400).send({ error: "A Stripe session or transaction id is required." });
      return;
    }

    if (body.bookingId) {
      const id = toObjectId(body.bookingId);
      const booking = id ? await bookings.findOne({ _id: id }) : null;
      if (!booking) {
        res.status(404).send({ error: "Booking not found." });
        return;
      }
      const owns =
        String(booking.customerId) === req.user.sub ||
        String(booking.customerEmail).toLowerCase() === req.user.email.toLowerCase();
      if (!owns) {
        res.status(403).send({ error: "You can only pay for your own booking." });
        return;
      }
      if (normalizeStatus(booking.status) !== "completed" || booking.paymentStatus === "paid") {
        res.status(409).send({ error: "Only an unpaid completed booking can be paid." });
        return;
      }
    }

    const payment = {
      bookingId: text(body.bookingId),
      serviceTitle: text(body.serviceTitle) || "Repair service",
      customerId: text(body.customerId),
      customerName: text(body.customerName),
      customerEmail: text(body.customerEmail),
      technicianId: text(body.technicianId),
      technicianName: text(body.technicianName),
      technicianEmail: text(body.technicianEmail),
      amount: number(body.amount),
      currency: "bdt",
      transactionId: text(body.transactionId) || stripeSessionId,
      stripeSessionId,
      paymentStatus: "paid",
      paidAt: body.paidAt || new Date().toISOString(),
      createdAt: body.createdAt || new Date().toISOString(),
    };

    if (payment.amount <= 0) {
      res.status(400).send({ error: "A payment amount greater than zero is required." });
      return;
    }

    const filter = stripeSessionId
      ? { stripeSessionId }
      : { transactionId: payment.transactionId };

    await payments.updateOne(filter, { $setOnInsert: payment }, { upsert: true });
    const saved = await payments.findOne(filter);
    res.status(201).send(paymentResponse(saved));
  } catch (err) {
    console.error("Create payment error:", err);
    res.status(500).send({ error: "An error occurred while saving the payment." });
  }
});

// Private convenience routes matching the assignment's API table.
app.get("/bookings/my", verifyToken, verifyCustomer, async (req, res) => {
  try {
    const { bookings } = await getCollections();
    const items = await bookings.find({
      $or: [{ customerId: req.user.sub }, { customerEmail: req.user.email }],
    }).sort({ createdAt: -1 }).toArray();
    res.status(200).send(items.map(bookingResponse));
  } catch (error) {
    console.error("Could not fetch customer bookings:", error);
    res.status(500).send({ error: "Could not fetch bookings." });
  }
});

app.get("/bookings/technician", verifyToken, verifyTechnician, async (req, res) => {
  try {
    const { bookings } = await getCollections();
    const items = await bookings.find({
      $or: [{ technicianId: req.user.sub }, { technicianEmail: req.user.email }],
    }).sort({ createdAt: -1 }).toArray();
    res.status(200).send(items.map(bookingResponse));
  } catch (error) {
    console.error("Could not fetch technician bookings:", error);
    res.status(500).send({ error: "Could not fetch bookings." });
  }
});

app.patch("/users/profile", verifyToken, async (req, res) => {
  try {
    const { users } = await getCollections();
    const updates = { ...req.body, updatedAt: new Date() };
    delete updates._id;
    delete updates.role;
    await users.updateOne({ _id: toObjectId(req.user.sub) }, { $set: updates });
    res.status(200).send({ updated: true });
  } catch (error) {
    console.error("Could not update profile:", error);
    res.status(500).send({ error: "Could not update profile." });
  }
});

app.get("/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  const { users } = await getCollections();
  const items = await users.find({}).toArray();
  res.status(200).send(items.map((user) => ({ ...user, _id: String(user._id) })));
});

app.patch("/admin/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
  if (req.params.id === req.user.sub) {
    res.status(403).send({ error: "You cannot change your own role." });
    return;
  }
  const role = text(req.body.role);
  if (!["customer", "technician", "admin"].includes(role)) {
    res.status(400).send({ error: "Choose a valid role." });
    return;
  }
  const { users } = await getCollections();
  await users.updateOne({ _id: toObjectId(req.params.id) }, { $set: { role } });
  res.status(200).send({ role });
});

app.patch("/admin/services/:id/approval", verifyToken, verifyAdmin, async (req, res) => {
  const approvalStatus = text(req.body.approvalStatus);
  if (!["pending", "approved", "rejected"].includes(approvalStatus)) {
    res.status(400).send({ error: "Choose a valid approval status." });
    return;
  }
  const { services } = await getCollections();
  const result = await services.updateOne(
    serviceFilter(req.params.id),
    { $set: { approvalStatus, updatedAt: new Date() } }
  );
  if (result.matchedCount === 0) {
    res.status(404).send({ error: "Service not found." });
    return;
  }
  res.status(200).send({ approvalStatus });
});

app.get("/admin/bookings", verifyToken, verifyAdmin, async (req, res) => {
  const { bookings } = await getCollections();
  const items = await bookings.find({}).sort({ createdAt: -1 }).toArray();
  res.status(200).send(items.map(bookingResponse));
});

app.get("/admin/payments", verifyToken, verifyAdmin, async (req, res) => {
  const { payments } = await getCollections();
  const items = await payments.find({}).sort({ paidAt: -1 }).toArray();
  res.status(200).send(items.map(paymentResponse));
});

// Local development only.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;

  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

export default app;
