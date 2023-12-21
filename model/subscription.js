import mongoose from "mongoose";

const subscribedUserSchema = new mongoose.Schema({
  username: String,
  subscribedAt: Number,
});

const subscriptionSchema = new mongoose.Schema(
  {
    ucid: { type: String, required: true, unique: true },
    channelName: String,
    subscribedUsers: [subscribedUserSchema],
    subscribedUsernames: [String],
  },
  { collection: "subscriptions" }
);

export const Subscription = mongoose.model("Subscription", subscriptionSchema);
