"""CloudFormation custom resource: AgentCore Identity outbound credential provider (Gateway -> MCP runtimes).

Why a custom resource: the Cognito machine client's secret must reach AgentCore Identity (which stores it
in its own Secrets Manager secret) without ever appearing in a CloudFormation template, parameter,
output or log. This function reads it with DescribeUserPoolClient and hands it straight to
CreateOauth2CredentialProvider.
"""
import json

import boto3

cognito = boto3.client("cognito-idp")
agentcore = boto3.client("bedrock-agentcore-control")


def _log(**f):
    print(json.dumps({"service": "identity-bootstrap", **f}))


def _provider_config(p):
    secret = cognito.describe_user_pool_client(UserPoolId=p["UserPoolId"], ClientId=p["M2MClientId"])["UserPoolClient"]["ClientSecret"]
    return {"customOauth2ProviderConfig": {"oauthDiscovery": {"discoveryUrl": p["DiscoveryUrl"]},
                                           "clientId": p["M2MClientId"], "clientSecret": secret}}


def _upsert_provider(p):
    name = p["ProviderName"]
    try:
        r = agentcore.create_oauth2_credential_provider(name=name, credentialProviderVendor="CustomOauth2",
                                                        oauth2ProviderConfigInput=_provider_config(p))
        _log(event="provider_created", name=name)
    except (agentcore.exceptions.ConflictException, agentcore.exceptions.ValidationException) as e:
        if "already exists" not in str(e) and not isinstance(e, agentcore.exceptions.ConflictException):
            raise
        r = agentcore.update_oauth2_credential_provider(name=name, credentialProviderVendor="CustomOauth2",
                                                        oauth2ProviderConfigInput=_provider_config(p))
        _log(event="provider_updated", name=name)
    return r["credentialProviderArn"]


def handler(event, _context):
    p = event["ResourceProperties"]
    rtype = event["RequestType"]
    _log(event="request", type=rtype)
    if rtype == "Delete":
        try:
            agentcore.delete_oauth2_credential_provider(name=p["ProviderName"])
        except agentcore.exceptions.ResourceNotFoundException:
            pass
        return {"PhysicalResourceId": event["PhysicalResourceId"]}
    arn = _upsert_provider(p)
    return {"PhysicalResourceId": p["ProviderName"], "Data": {"ProviderArn": arn}}
