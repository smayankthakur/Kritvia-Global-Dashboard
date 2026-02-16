process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "kritviya_test_jwt_secret";
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "15m";
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";
process.env.COOKIE_SECURE = "false";
process.env.RAZORPAY_WEBHOOK_SECRET =
  process.env.RAZORPAY_WEBHOOK_SECRET || "kritviya_webhook_test_secret";
