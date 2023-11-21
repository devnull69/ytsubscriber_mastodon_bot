import mongoose from "mongoose";

const metadataSchema = new mongoose.Schema(
  {
    lastchecked: { type: Number, required: true, unique: true },
  },
  { collection: "metadata" }
);

export const Metadata = mongoose.model("Metadata", metadataSchema);
