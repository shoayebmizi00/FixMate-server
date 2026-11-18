import { MongoClient } from 'mongodb';
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import 'dotenv/config';
dotenv.config();

const PORT = process.env.PORT || 5000;

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

app.get("/", (req, res) => {
  res.send({message: "FixMate server is running!"});
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
})