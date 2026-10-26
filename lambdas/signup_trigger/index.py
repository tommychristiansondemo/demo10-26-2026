"""Cognito triggers for student self-sign-up (no e-mail, no MFA).

PreSignUp:        validate the chosen role (custom:role = analyst | reader) and username, then auto-confirm.
PostConfirmation: add the new user to the Cognito group of that role. The group drives tool access in TrialScout
                  (cognito:groups claim -> agent ROLE_TOOLS + Gateway RBAC interceptor).
"""
import json
import re

import boto3

ROLES = {"analyst", "reader"}
USERNAME = re.compile(r"[A-Za-z0-9_.-]{3,32}")
cognito = boto3.client("cognito-idp")


def handler(event, _context):
    source = event["triggerSource"]
    role = event["request"].get("userAttributes", {}).get("custom:role", "reader")
    if source.startswith("PreSignUp"):
        if role not in ROLES:
            raise Exception("Choose a role: analyst or reader.")
        if not USERNAME.fullmatch(event["userName"]):
            raise Exception("Username must be 3-32 characters: letters, digits, '.', '_' or '-'.")
        event["response"]["autoConfirmUser"] = True
    elif source == "PostConfirmation_ConfirmSignUp":
        cognito.admin_add_user_to_group(UserPoolId=event["userPoolId"], Username=event["userName"], GroupName=role)
    print(json.dumps({"service": "signup-trigger", "event": source, "role": role}))
    return event
