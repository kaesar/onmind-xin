import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";

// AWS Lambda (Node.js 24): handler `src/lambda.handler`.
// Env: XIN_TABLE=xemails, XIN_STORAGE=dynamodb, XIN_API_KEY (behind API Gateway),
// AWS_REGION. No SMTP server on Lambda (HTTP API only).
const app = createApp(process.env);
export const handler = handle(app);
