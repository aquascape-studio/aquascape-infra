#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { BootstrapStack } from "../lib/stacks/BootstrapStack";
import { NetworkStack } from "../lib/stacks/NetworkStack";
import { EdgeStack } from "../lib/stacks/EdgeStack";
import { AppStack, albDnsExportName, taskOriginHostname } from "../lib/stacks/AppStack";

const app = new cdk.App();

const ACCOUNT = "063418083301";
const REGION = "us-east-1";
const GITHUB_USER = "aquascape-studio";
const DOMAIN = "efferves.live";

/**
 * Per-account bootstrap. Trusts every aquascape-* repo to assume the
 * deploy role for its target environment.
 */
new BootstrapStack(app, "AquascapeStudio-Bootstrap", {
  env: { account: ACCOUNT, region: REGION },
  githubUser: GITHUB_USER,
  repoNames: [
    "aquascape-infra",
    "aquascape-api",
    "aquascape-sim",
    "aquascape-web",
    "aquascape-mobile",
    // botany, ui, render, proto publish packages via GITHUB_TOKEN only — no AWS needed.
  ],
  environments: ["dev", "stage", "prod"],
});

/**
 * Per-env stacks. Selected by `cdk deploy --context env=dev`.
 */
const envName = (app.node.tryGetContext("env") ?? "dev") as "dev" | "stage" | "prod";
const common = {
  env: { account: ACCOUNT, region: REGION },
  envName,
  domainName: DOMAIN,
};

// ALB only in prod for now; dev goes CloudFront → web task directly.
// Set true for an env when it needs to scale beyond one task.
const useAlb = envName === "prod";

const network = new NetworkStack(app, `AquascapeStudio-Network-${envName}`, common);
const edge = new EdgeStack(app, `AquascapeStudio-Edge-${envName}`, {
  ...common,
  ...(envName !== "prod" ? { subdomain: envName } : {}),
});
const appStack = new AppStack(app, `AquascapeStudio-App-${envName}`, {
  ...common,
  vpc: network.vpc,
  certificate: edge.certificate,
  useAlb,
});
appStack.addDependency(network);
appStack.addDependency(edge);

// Wire CloudFront → ALB (or web task) behaviors AFTER AppStack is created.
if (useAlb) {
  edge.wireAlbBehaviors(albDnsExportName(envName));
} else {
  edge.wireTaskOriginBehaviors(taskOriginHostname(envName, DOMAIN));
}

app.synth();
