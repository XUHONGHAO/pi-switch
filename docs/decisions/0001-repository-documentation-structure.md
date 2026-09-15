# ADR 0001：采用面向 AI 的文档分层

- 状态：accepted
- 日期：2026-08-13

## 背景

项目初期的安装、开发、路线图和评审文档分散在根目录与 `dev-docs/`，需求、当前架构、计划和历史评审之间缺少稳定边界。后续将大量使用 AI 开发，需要低歧义、可定位的上下文。

## 决策

保留根目录最少量入口文件，并将文档划分为 `requirements`、`architecture`、`decisions`、`plans`、`reviews`、`development` 和 `guides`。根目录 `AGENTS.md` 作为 AI 与贡献者的首要开发约定；每个主要目录提供简短 README。

## 后果

文档查找和自动化上下文选择更稳定，但维护者必须避免同一事实在多处复制。Review 和 plan 不作为当前产品行为的权威来源，长期结论需回写到需求、架构或 ADR。
