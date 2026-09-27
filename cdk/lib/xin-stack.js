// OnMind-XIN stack: one Lambda (Hono app) fronted by an HTTP API (API Gateway v2)
// backed by a single DynamoDB table. The Lambda code is an ASSET of the REPO ROOT
// (the same tree the Bun container runs), so `src/lambda.handler` +
// node_modules ship as-is — no bundling step.
//
// Auth is enforced by the app, not the gateway (same parity idea as XID):
// XIN_API_KEY (except /health). No usage plan on HTTP API v2 — harden to a
// REST API later if per-key quota is required.
//
// Config is CDK context (cdk.json defaults, overridable with -c key=value):
//   apiKey           OPTIONAL: XIN_API_KEY. Prefer the XIN_API_KEY env var so
//                    the secret never hits argv/shell history. Empty = open
//                    API (fine for Floci/throwaway; set it in prod).
//   removalPolicy    retain (default, prod) | destroy (throwaway/Floci envs)
//   deletionProtection  true (default) | false — blocks even explicit
//                    DeleteTable while the stack exists
//   pointInTimeRecovery true (default) | false — 35-day PITR
//   tablePrefix      prepended to xemails (multi-env accounts)
//   xinEnv           XIN_ENV for the app (default production)
//   corsOrigins      comma list → XIN_CORS_ORIGINS
//   localEndpoint    emulator URL (Floci/LocalStack) → AWS_ENDPOINT_URL +
//                    XIN_DYNAMO_ENDPOINT inside the Lambda
'use strict'
const path = require('node:path')
const cdk = require('aws-cdk-lib')
const lambda = require('aws-cdk-lib/aws-lambda')
const dynamodb = require('aws-cdk-lib/aws-dynamodb')
const apigwv2 = require('aws-cdk-lib/aws-apigatewayv2')
const { HttpLambdaIntegration } = require('aws-cdk-lib/aws-apigatewayv2-integrations')
const logs = require('aws-cdk-lib/aws-logs')

const REPO_ROOT = path.join(__dirname, '..', '..')

function ctx(stack, key, def = '') {
  const v = stack.node.tryGetContext(key)
  return v === undefined || v === null || v === '' ? def : v
}

function ctxBool(stack, key, def) {
  const v = stack.node.tryGetContext(key)
  if (v === undefined || v === null || v === '') return def
  return v === true || v === 'true'
}

function ctxList(stack, key) {
  return String(ctx(stack, key, ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

class XinStack extends cdk.Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, props)

    const tablePrefix = String(ctx(this, 'tablePrefix', ''))
    const removal =
      String(ctx(this, 'removalPolicy', 'retain')).toLowerCase() === 'destroy'
        ? cdk.RemovalPolicy.DESTROY
        : cdk.RemovalPolicy.RETAIN
    const deletionProtection = ctxBool(this, 'deletionProtection', true)
    const pitr = ctxBool(this, 'pointInTimeRecovery', true)

    // ---------- DynamoDB ----------
    // Schema must match src/storage.js: messageId (S) = pk, ttl (N) = epoch
    // seconds (30 days), data (S) = full entry JSON + flat attrs.
    const emailsTable = new dynamodb.Table(this, 'xemailsTable', {
      tableName: `${tablePrefix}xemails`,
      partitionKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: pitr },
      timeToLiveAttribute: 'ttl',
      removalPolicy: removal,
      deletionProtection,
    })

    // ---------- Lambda env ----------
    // XIN_API_KEY is optional at synth (unlike XID_JWT_SECRET): empty means
    // the API runs open — fine for Floci/throwaway, set it for prod.
    // Prefer the XIN_API_KEY env var so the secret never hits argv/history.
    const apiKey = process.env.XIN_API_KEY || String(ctx(this, 'apiKey', ''))

    const fnEnv = {
      XIN_ENV: String(ctx(this, 'xinEnv', 'production')),
      XIN_STORAGE: 'dynamodb',
      XIN_TABLE: emailsTable.tableName,
    }
    if (apiKey) fnEnv.XIN_API_KEY = apiKey
    const cors = ctxList(this, 'corsOrigins')
    if (cors.length) fnEnv.XIN_CORS_ORIGINS = cors.join(',')

    // Floci/LocalStack: SDK v3 resolves AWS_ENDPOINT_URL globally; storage.js
    // additionally honours XIN_DYNAMO_ENDPOINT (both set for belt and braces).
    const localEndpoint = String(ctx(this, 'localEndpoint', ''))
    if (localEndpoint) {
      fnEnv.AWS_ENDPOINT_URL = localEndpoint
      fnEnv.XIN_DYNAMO_ENDPOINT = localEndpoint
    }

    // ---------- Lambda ----------
    const xinFn = new lambda.Function(this, 'XinFunction', {
      description: 'OnMind-XIN SES emulator (Hono, HTTP API only)',
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'src/lambda.handler',
      // Repo-root asset: keep in sync with the tree the Bun container runs.
      code: lambda.Code.fromAsset(REPO_ROOT, {
        exclude: [
          '.git',
          '.github',
          'cdk', // this CDK app + its node_modules
          'PLAN.md',
          'xemails.json', // local throwaway data, never ship
          '.env',
          '.dev.vars',
          '*.log',
          'bun.lock',
        ],
      }),
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: fnEnv,
      // Explicit log group (retention set here; `logRetention` is deprecated).
      // The AWSLambdaBasicExecutionRole policy covers logs on arn:aws:logs:*:*:*.
      logGroup: new logs.LogGroup(this, 'XinLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: removal,
      }),
    })
    emailsTable.grantReadWriteData(xinFn)

    // ---------- HTTP API ----------
    // Public front door for the SES emulation + REST readers:
    // ANY / and ANY /{proxy+} → Lambda. The API key is enforced by the app
    // (XIN_API_KEY), so the gateway stays out of the way.
    const api = new apigwv2.HttpApi(this, 'XinHttpApi', {
      apiName: `${tablePrefix}xin-api`,
      description: 'OnMind-XIN API (SES emulation + messages)',
    })

    const integration = new HttpLambdaIntegration('LambdaIntegration', xinFn)
    api.addRoutes({ path: '/{proxy+}', methods: [apigwv2.HttpMethod.ANY], integration })
    api.addRoutes({ path: '/', methods: [apigwv2.HttpMethod.ANY], integration })

    // ---------- Outputs ----------
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.apiEndpoint,
      description: 'Base URL (SES endpoint / messages entry point)',
    })
    new cdk.CfnOutput(this, 'ApiId', {
      value: api.apiId,
      description: 'HTTP API id (for future custom-domain ApiMapping)',
    })
    new cdk.CfnOutput(this, 'FunctionName', { value: xinFn.functionName })
    new cdk.CfnOutput(this, 'EmailsTable', { value: emailsTable.tableName })
  }
}

module.exports = { XinStack }
