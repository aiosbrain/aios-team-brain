"""Codebase analyzers: derive health/AI-transformation metrics from a repo.

The brain computes agentic/health scores (lib/codebases/score.ts) from raw inputs. The one
exception is AEM agent-readiness, scored scanner-side (analyzers/readiness.py) because its
checks are filesystem questions the brain can't answer; the brain persists it verbatim.
"""

from .codebase import analyze_history, analyze_repo

__all__ = ["analyze_history", "analyze_repo"]
