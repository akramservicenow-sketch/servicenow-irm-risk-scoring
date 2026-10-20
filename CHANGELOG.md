# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-10-19

### Added
- `RiskScoringCore`: a platform-independent ES5 scoring engine covering the configurable likelihood x impact
  matrix, design/operating control effectiveness with a design gate, complement/max/average control
  aggregation with a reduction cap, residual scoring, rating bands, category-specific appetite and
  tolerance, entity roll-up (max, weighted average, average), review due dates, and a heat map grid.
- Strict input and configuration validation (`RiskScoringValidationError`).
- ServiceNow wrappers: the `RiskScoringService` Script Include, three sample Business Rules, a Flow Designer
  script step, and a Scripted REST resource (`POST /assess`).
- Configuration through the `x_irmrs.*` system properties.
- Node test suite with a vm-based ServiceNow runtime and mocks, plus an ES5/scoped-app compatibility check.
- Synthetic risk register, a deterministic Markdown report generator, and GitHub Actions CI.
