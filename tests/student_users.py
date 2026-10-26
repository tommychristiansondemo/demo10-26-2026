"""Ephemeral student accounts for the live tests, created exactly the way students create theirs:
public SignUp with custom:role (PreSignUp trigger auto-confirms, PostConfirmation adds the group).
Passwords are random, held in memory only, and every account is deleted when the test session ends."""
from __future__ import annotations

import atexit
import secrets as _rand

import boto3

REGION = "us-east-1"
cognito = boto3.client("cognito-idp", region_name=REGION)
_created: list[tuple[str, str]] = []


def create(pool_id: str, client_id: str, role: str) -> tuple[str, str]:
    """Self-sign-up a fresh user with the given role; returns (username, password)."""
    username = f"smoke-{role}-{_rand.token_hex(3)}"
    password = _rand.token_urlsafe(12)
    cognito.sign_up(ClientId=client_id, Username=username, Password=password,
                    UserAttributes=[{"Name": "custom:role", "Value": role}])
    _created.append((pool_id, username))
    return username, password


def access_token(pool_id: str, client_id: str, username: str, password: str) -> str:
    r = cognito.admin_initiate_auth(UserPoolId=pool_id, ClientId=client_id, AuthFlow="ADMIN_USER_PASSWORD_AUTH",
                                    AuthParameters={"USERNAME": username, "PASSWORD": password})
    return r["AuthenticationResult"]["AccessToken"]


@atexit.register
def _cleanup() -> None:
    for pool_id, username in _created:
        try:
            cognito.admin_delete_user(UserPoolId=pool_id, Username=username)
        except Exception:
            pass
