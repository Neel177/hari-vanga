# Hari Bhanga / হাঁড়ি ভাঙা

A real-time meal tracker for Bengali mess life. The UI is deliberately playful; Firebase provides the production data layer.

## Setup

1. Create a Firebase project and register a **Web app**.
2. Enable **Authentication → Google** and add your development/production domains to Authorized domains.
3. Create a **Cloud Firestore** database (production mode).
4. Copy `.env.example` to `.env` and fill the `VITE_FIREBASE_*` values.
5. Install the Firebase CLI, then deploy the Firestore rules: `firebase deploy --only firestore:rules`.
6. Run `npm install`, then `npm run dev`.

Firestore listeners subscribe to mess, membership, month, status, and meal-record collections. Each edit writes one document, so concurrent managers do not overwrite the month. Joining is Firestore-only: an authenticated user reads a secret invite document by its code and atomically creates their own membership and profile link—no Cloud Functions or Blaze plan needed.
