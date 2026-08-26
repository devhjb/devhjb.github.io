---
layout: post
title: "从库存黑盒到生产闭环：轻制造 SaaS 的 MRP Lite 架构实践"
date: 2026-08-25 10:00:00 +0800
category: "架构实践"
series: "轻制造 MRP Lite 架构复盘"
summary: "从新兴市场中小工厂的真实约束出发，复盘一套轻制造 MRP Lite 系统的业务建模、库存闭环、事务一致性和后端架构设计。"
featured: false
links:
  - label: "掘金"
    url: "https://juejin.cn/post/7677878351721332746"
  - label: "CSDN"
    url: "https://blog.csdn.net/qq_45481524/article/details/164066354?spm=1001.2014.3001.5501"
tags:
  - SaaS ERP
  - MRP Lite
  - 架构设计
---

这篇文章目前以外部平台发布版本为准，本站先保留索引、摘要和同步链接。

## 摘要

从新兴市场中小工厂的真实约束出发，复盘一套轻制造 MRP Lite 系统的业务建模、库存闭环、事务一致性和后端架构设计。

文章围绕“原料出了多少、生产交付多少、差异多少、成品入了多少”这条生产主线，讨论 BOM 净需求、生产计划、工单、领退料、报工质检、生产入库、库存预占、在制台账、幂等与事务一致性等关键问题。

重点不在复刻完整 MES，而在说明如何让一个 SaaS 系统在前端交互尽量轻的情况下，仍然通过后端单据、状态机和库存流水守住业务账、库存账和责任闭环。

## 同步阅读

- [掘金](https://juejin.cn/post/7677878351721332746)
- [CSDN](https://blog.csdn.net/qq_45481524/article/details/164066354?spm=1001.2014.3001.5501)
