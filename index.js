
import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient } from "mongodb";

const app = express();

app.use(cors());
app.use(express.json());

// MongoDB connection
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

// Get database collections
async function getCollections() {
  const connectedClient = await connectToMongoDB();

  const db = connectedClient.db("fixmate");

  return {
    users: db.collection("user"),
    services: db.collection("services"),
  };
}

// Home route
app.get("/", (req, res) => {
  res.send({ message: "FixMate server is running!" });
});

// Get all users
app.get("/users", async (req, res) => {
  try {
    const { users } = await getCollections();

    const allUsers = await users.find().toArray();

    res.status(200).send(allUsers);
  } catch (err) {
    console.error("Users error:", err);

    res.status(500).send({
      error: "An error occurred while fetching users.",
    });
  }
});

// Get all services
app.get("/services", async (req, res) => {
  try {
    const { services } = await getCollections();

    const allServices = await services.find().toArray();

    res.status(200).send(allServices);
  } catch (err) {
    console.error("Services error:", err);

    res.status(500).send({
      error: "An error occurred while fetching services.",
    });
  }
});

// Create a new service
app.post("/services", async (req, res) => {
  try {
    const { services } = await getCollections();

    const newService = req.body;

    const result = await services.insertOne(newService);

    res.status(201).send(result);
  } catch (err) {
    console.error("Create service error:", err);

    res.status(500).send({
      error: "An error occurred while creating a service.",
    });
  }
});

// Local development only
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;

  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

// Export Express application for Vercel
export default app;
