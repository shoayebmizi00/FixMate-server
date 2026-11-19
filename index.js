import { MongoClient } from 'mongodb';
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import 'dotenv/config';
dotenv.config();

const PORT = process.env.PORT;

const app = express();

app.use(cors());
app.use(express.json());


const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
const db = connectedClient.db("fixmate");
const users = db.collection("user");
const services = db.collection("services");

app.get("/users", async (req, res) => {
  try {
    const allUsers = await users.find().toArray();
    res.send(allUsers);
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "An error occurred while fetching users." });
  }
});

app.get("/services", async (req, res) => {
  try {
    const allServices = await services.find().toArray();
    res.send(allServices);
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "An error occurred while fetching services." });
  }
});

app.post("/services", async (req, res) => {
  try {
    const newService = req.body;
    const result = await services.insertOne(newService);
    res.status(201).send(result);
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "An error occurred while creating a service." });
  }
});

app.get("/", (req, res) => {
  res.send({message: "FixMate server is running!"});
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
})


export default app;