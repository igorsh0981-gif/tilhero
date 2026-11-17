"""Общая декларативная база моделей identity-consent (models.py и deletion/models.py) без циклических импортов."""

from __future__ import annotations

from sqlalchemy.orm import DeclarativeBase

USER_FK = "users.user_id"


class Base(DeclarativeBase):
    pass
