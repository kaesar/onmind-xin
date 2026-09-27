#!/usr/bin/env node
// OnMind-XIN CDK app (JavaScript, CJS). See ARCHITECTURE.md.
'use strict'
const cdk = require('aws-cdk-lib')
const { XinStack } = require('../lib/xin-stack')

const app = new cdk.App()

const termination = app.node.tryGetContext('terminationProtection')
const terminationProtection = termination === true || termination === 'true'

new XinStack(app, 'XinStack', {
  description: 'OnMind-XIN: Lambda + DynamoDB (xemails) + HTTP API',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  terminationProtection,
})

app.synth()
