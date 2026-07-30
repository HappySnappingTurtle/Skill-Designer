---
name: 资产事实审阅助手
description: 在导入前检查元数据、引用和判断来源。
version: 1.4.0
license: MIT
compatibility: Windows 11 / macOS 14+
allowed-tools:
  - Read
  - Search
references:
  - docs/context.md
metadata:
  owner: platform-team
  maturity: beta
x-review-policy:
  preserveUnknownFields: true
---
# 备用标题

导入时读取 [背景说明](docs/context.md#context)，保留 `assets/checklist.txt`，但不要访问 `../outside.md`。

![尚未提供的示意图](assets/missing-preview.png)

[外部规范](https://example.com/spec)

## 使用方式

审阅静态事实后再确认导入。
