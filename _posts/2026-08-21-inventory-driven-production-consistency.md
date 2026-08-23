---
layout: post
title: "库存驱动生产系统里的事务、幂等、预占与在制台账设计"
date: 2026-08-21 09:00:00 +0800
category: "工程架构"
series: "MRP Lite 系列 02"
summary: "讨论库存移动编排、库存预占、在制台账、事务边界、幂等、UNKNOWN 状态和数量原子累加。"
featured: false
links:
  - label: "掘金"
    url: "https://juejin.cn/post/7675595046835077129"
  - label: "CSDN"
    url: "https://blog.csdn.net/qq_45481524/article/details/163909169?spm=1001.2014.3001.5501"
tags:
  - SaaS ERP
  - 库存系统
  - 事务一致性
---

这篇文章目前以外部平台发布版本为准，本站先保留索引、摘要和同步链接。

## 摘要

讨论库存移动编排、库存预占、在制台账、事务边界、幂等、UNKNOWN 状态和数量原子累加。

## 同步阅读

- [掘金](https://juejin.cn/post/7675595046835077129)
- [CSDN](https://blog.csdn.net/qq_45481524/article/details/163909169?spm=1001.2014.3001.5501)
