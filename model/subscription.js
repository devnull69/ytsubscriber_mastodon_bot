import mongoose from "mongoose";

const subscriptionSchema = new mongoose.Schema(
  {
    ucid: { type: String, required: true, unique: true },
    channelName: { type: String },
    subscribedUsernames: { type: [String], required: true },
  },
  { collection: "subscriptions" }
);

export const Subscription = mongoose.model("Subscription", subscriptionSchema);
