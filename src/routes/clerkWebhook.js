import { Router } from "express";
import express from "express";
import { verifyWebhook } from "@clerk/express/webhooks";

import prisma from "../config/prisma.js";
import { syncClerkUser } from "../services/userService.js";

const router = Router();

router.post("/clerk", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = await verifyWebhook(req);
  } catch (error) {
    console.warn("Rejected Clerk webhook with an invalid signature:", error.message);
    return res.status(400).send("Invalid webhook signature");
  }

  try {
    if (event.type === "user.created") {
      await syncClerkUser(event.data, { createIfMissing: true });
    } else if (event.type === "user.updated") {
      await syncClerkUser(event.data);
    } else if (event.type === "user.deleted" && event.data.id) {
      await prisma.users.updateMany({
        where: { clerk_user_id: event.data.id },
        data: { status: "inactive", updated_at: new Date() },
      });
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    // Non-2xx makes Clerk retry transient provisioning/database failures.
    console.error(`Failed to process Clerk ${event.type} webhook:`, error);
    return res.status(500).send("Could not sync Clerk user");
  }
});

export default router;
