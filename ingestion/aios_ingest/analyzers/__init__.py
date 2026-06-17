"""Codebase analyzers: derive RAW health/AI-transformation metrics from a repo.

The brain computes scores (lib/codebases/score.ts); analyzers only measure.
"""

from .codebase import analyze_repo

__all__ = ["analyze_repo"]
