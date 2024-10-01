import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true },
    subscribedTo: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Subscription",
      },
    ],
    instance: { type: String, required: true, default: "fixed" },
  },
  { collection: "users" }
);

export const User = mongoose.model("User", userSchema);
