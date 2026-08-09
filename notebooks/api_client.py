"""Thin HTTP helpers for the Walk + Transit notebook."""

from __future__ import annotations

from typing import Any

import requests


class TransitApiClient:
    def __init__(self, base_url: str = "http://127.0.0.1:3010", timeout: float = 60.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def health(self) -> dict[str, Any]:
        response = self.session.get(self._url("/health"), timeout=self.timeout)
        response.raise_for_status()
        return response.json()

    def config(self) -> dict[str, Any]:
        response = self.session.get(self._url("/v1/config"), timeout=self.timeout)
        response.raise_for_status()
        return response.json()

    def gtfs_status(self) -> dict[str, Any]:
        response = self.session.get(self._url("/v1/gtfs/status"), timeout=self.timeout)
        response.raise_for_status()
        return response.json()

    def search_places(self, query: str, limit: int = 5) -> dict[str, Any]:
        response = self.session.get(
            self._url("/v1/places/search"),
            params={"q": query, "limit": limit},
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json()

    def plan_direct(
        self,
        *,
        mode: str,
        origin: dict[str, float],
        destination: dict[str, float],
        max_walking_seconds: int,
    ) -> tuple[dict[str, Any], float]:
        import time

        started = time.perf_counter()
        response = self.session.post(
            self._url("/v1/plans/direct"),
            json={
                "mode": mode,
                "origin": origin,
                "destination": destination,
                "maxWalkingSeconds": max_walking_seconds,
            },
            timeout=self.timeout,
        )
        elapsed = time.perf_counter() - started
        payload = response.json()
        if not response.ok:
            raise RuntimeError(f"Plan failed ({response.status_code}): {payload}")
        return payload, elapsed
