---
layout: post
title: "业务操作日志不是字段审计：快照 Diff、幂等账本与业务语义建模"
date: 2026-08-25
category: "业务系统工程"
series: "业务建模 01"
summary: "一次业务操作日志体系设计与落地复盘：从字段审计的局限切入，拆解快照 Diff、afterCommit 投递、异步幂等账本、查询时渲染和业务语义建模。"
cover: "/assets/posts/business-operation-log/cover.png"
featured: true
links:
  - label: "掘金"
    url: "https://juejin.cn/post/7677515319150641202"
  - label: "CSDN"
    url: "https://blog.csdn.net/qq_45481524/article/details/164047194?spm=1001.2014.3001.5501"
tags:
  - Java
  - Spring Boot
  - SaaS
  - 业务操作日志
  - 领域建模
  - 幂等
---

## 摘要

很多系统做“操作日志”时，第一反应是记录字段变化：

```text
status: 1 -> 2
amount: 80 -> 100
updated_by: 12 -> 12
updated_at: 2026-08-25 10:00:00 -> 2026-08-25 10:01:00
```

这类日志有价值，但它更接近字段审计或数据库变更记录。

真正面向 ERP、SaaS、业财链路和复杂业务系统的业务操作日志，要回答的是另一组问题：

```text
谁
在什么时间
从什么入口
对哪个业务对象
做了什么业务动作
结果如何
关键业务变化是什么
```

字段变化只能说明“值变了”，不能直接说明“业务发生了什么”。

所以业务操作日志的核心不是把所有字段都记下来，而是建立一套轻量业务动作账本：

```text
业务语义建模
  -> 快照白名单
  -> oldSnapshot / newSnapshot
  -> 受控 Diff
  -> humanTexts
  -> 幂等账本
  -> 查询时渲染
```

这篇文章聊一次业务操作日志体系从 0 到 1 的设计取舍：为什么它不是字段审计，复杂业务为什么要显式快照，Diff 为什么只看白名单，成功日志为什么必须 afterCommit 投递，以及幂等账本为什么是审计系统的底线。

## 1. 为什么字段审计不够

字段审计通常关注：

```text
哪张表
哪一行
哪个字段
从什么值变成什么值
```

这在一些场景里很有用，例如排查“谁改了配置字段”“某个状态什么时候变了”。

但在复杂业务系统里，它很快会暴露几个问题。

### 1.1 字段名不是业务动作

例如你看到：

```text
status: 1 -> 2
```

这到底代表什么？

可能是：

```text
采购单提交审核
采购单审核通过
采购单作废
工单开工
订单支付完成
库存调拨完成
```

同一个字段变化，在不同业务对象、不同入口、不同前置状态下，业务含义完全不同。

如果日志只记录字段变化，最后查询页面上会出现一堆“status 从 1 变成 2”。业务人员看不懂，审计人员也很难直接判断风险。

### 1.2 数据库字段不等于用户可读信息

字段审计里常见的是：

```text
supplier_id: 10086 -> 10087
warehouse_id: 3 -> 7
payment_method: 1 -> 2
```

但业务侧真正想看到的是：

```text
供应商从“华东供应商 A”改为“华南供应商 B”
仓库从“上海一仓”改为“广州二仓”
付款方式从“现金”改为“银行转账”
```

这就要求日志系统能保存展示值，或者保存足够的 i18n key 和渲染参数。

如果查询时再反查业务表补展示值，会引入另一个问题：业务对象可能已经被改名、删除或归档，历史日志会被当前状态污染。

### 1.3 多表单据不是一行记录

ERP 系统里很多业务对象不是单表：

```text
采购单 = 主表 + 明细行 + 费用 + 收货关联 + 付款关联
生产工单 = 主表 + 物料明细 + 工序 + 报工 + 质检 + 入库
餐饮订单 = 桌台 + 订单 + 菜品明细 + 支付 + 打印
```

字段审计如果按数据库行记录，很难表达：

```text
新增了一行物料
删除了一行费用
某个明细行的数量从 5 改成 8
某个菜品从普通菜改为赠品
```

业务操作日志必须先把“这个业务对象在日志视角下长什么样”定义清楚，然后再比较。

### 1.4 技术字段容易污染业务视图

如果直接审计所有字段，很容易出现：

```text
updated_time 变化
version 变化
sync_status 变化
last_modified_by 变化
```

这些字段对开发排查可能有用，但对业务审计不一定有意义。

业务操作日志应该关心“业务动作账本”，不是把数据库行所有变化都倾倒到页面上。

## 2. 业务操作日志到底要记录什么

我更倾向把业务操作日志定义成：

```text
ERP 业务动作账本
```

它不是普通应用日志，也不是数据库 binlog，更不是字段审计的简单包装。

它至少要回答七个问题：

| 问题 | 示例 |
| --- | --- |
| 谁 | 张三、系统任务、外部回调 |
| 什么时间 | 当前租户时区下的操作时间 |
| 从什么入口 | 商品修改、采购单审核、报表导出 |
| 对哪个对象 | 商品、采购单、工单、桌台、配置 |
| 做了什么动作 | 创建、修改、审核、取消、导出、打印 |
| 结果如何 | 成功、失败、部分成功 |
| 关键变化是什么 | 明细新增、金额变更、状态流转、配置调整 |

所以日志模型不应该只有：

```text
tableName
rowId
fieldName
oldValue
newValue
```

而应该有更完整的业务语义：

```text
moduleType
targetType
businessId / businessNo
businessName
operationType
operationSource
actionKey
operator
result
humanTexts
diffDetails
snapshot
idempotentKey
```

其中 `actionKey` 很重要。

`operationType` 适合放粗粒度动作：

```text
CREATE / MODIFY / REMOVE / REVIEW / CANCEL / EXPORT / PRINT
```

但不要把所有业务动作都塞进枚举里。

更细的动作应该放在 `actionKey`：

```text
product.modify
purchaseOrder.review
workOrder.issueMaterial
report.export
receipt.print
```

这样既能保持枚举稳定，又能承载业务入口语义。

## 3. 哪些动作应该进业务操作日志

业务操作日志不是所有请求都记录。

普通查询和普通详情，一般不应该进入业务操作日志。否则日志量会迅速膨胀，真正有审计价值的动作会被淹没。

推荐记录的动作包括：

| 动作 | 说明 |
| --- | --- |
| CREATE | 创建主数据或业务单据 |
| MODIFY | 修改主数据、单据、配置、状态 |
| REMOVE | 删除、逻辑删除、移除绑定关系 |
| REVIEW / APPROVE | 审核、审批、通过、驳回 |
| CANCEL | 取消订单、取消任务 |
| REVERSE / ROLLBACK | 冲销、反审、撤销、回滚 |
| IMPORT | 导入产生的创建或批量变更 |
| EXPORT | 导出数据 |
| DOWNLOAD | 下载文件、模板、单据、报表 |
| PRINT | 打印单据、标签、小票 |
| SENSITIVE_VIEW | 敏感数据查看 |

认证类行为不建议混进业务操作日志：

```text
登录
登出
token 刷新
密码错误
账号冻结
```

这些更适合放在登录审计或安全审计里。

业务操作日志关注的是业务对象和业务动作，安全审计关注的是账号与访问行为。边界混在一起，后面查询、权限和告警都会变复杂。

## 4. 简单动作可以规则采集，复杂动作必须显式快照

业务操作日志最容易走偏的地方，是幻想“全自动采集”。

比如希望靠 AOP 拦截所有 Controller，然后自动拿参数、拿返回值、自动生成日志。

这对简单动作可以，但对复杂业务不够。

我会把采集方式分成两类。

### 4.1 简单动作：规则表 + AOP

适合：

```text
导出
下载
打印
简单创建
简单审核
简单删除
```

这些动作的特点是：

- 入口明确。
- 业务对象容易从参数或返回值里拿到。
- 不需要复杂 old/new 快照。
- 日志文本可以通过规则模板生成。

例如：

```text
用户导出了库存报表
用户打印了采购单
用户下载了导入模板
```

这类场景用规则表配置：

```text
actionKey
operationType
targetType
businessId 表达式
businessNo 表达式
humanText 模板
```

再通过 AOP 采集，成本比较低。

### 4.2 复杂动作：Service 显式快照

适合：

```text
复杂 UPDATE
主从表单据修改
审批流状态变更
库存、财务、生产等带副作用动作
```

这类动作不应该交给 AOP 自动猜。

正确方式是业务 Service 明确声明快照边界：

```text
1. 查询 oldSnapshot
2. 执行业务修改
3. 查询 newSnapshot
4. 生成 diffDetails
5. 渲染 humanTexts
6. 发布业务操作日志事件
```

伪代码可以写成这样：

```java
BusinessSnapshot oldSnapshot = snapshotService.findSnapshot(targetId);

doBusinessModify(command);

BusinessSnapshot newSnapshot = snapshotService.findSnapshot(targetId);

operationLogPublisher.publishDiff(oldSnapshot, newSnapshot, eventMeta);
```

这里有个关键点：

```text
newSnapshot 必须代表业务方法结束后的最终状态。
```

日志 SDK 不应该反过来重新理解业务模型。它不应该自己去查商品、查采购单、查库存、查工单。业务对象的聚合边界应该由业务 Service 明确提供。

## 5. 快照不是数据库全量对象，而是日志白名单

很多人一听“快照”，会以为要把数据库对象完整保存下来。

不应该这样做。

业务操作日志快照不是数据库全量对象，而是日志字段白名单。

一个合格的日志快照应该满足：

- 能定位业务对象。
- 能说明关键业务字段。
- 能支持字段级 diff。
- 能支持用户可读展示。
- 不包含无意义技术字段。
- 不包含敏感字段。

统一快照模型可以抽象成：

```text
Snapshot
  - targetType
  - businessId
  - businessNo
  - businessName
  - sections

Section
  - sectionKey
  - sectionName
  - fields
  - rows

Field
  - fieldKey
  - value
  - displayValue
  - valueType
  - sensitive

Row
  - rowKey
  - rowName
  - fields
```

这里最重要的三个 key 是：

```text
sectionKey
rowKey
fieldKey
```

它们是日志层的稳定契约。

举个例子，采购单明细可以按 `rowKey` 对齐：

```text
material:10086
fee:freight
payment:cash
```

这样才能识别：

```text
新增了一行物料
删除了一项费用
某一行数量发生变化
```

如果只对两个 Java 对象或两个 Map 做深度比较，就很容易得到一堆技术差异，而不是业务可读差异。

## 6. Diff 只比较 value，展示用 displayValue

Diff 引擎第一版不应该做得太“聪明”。

它的职责越清晰越好：

```text
sectionKey 对齐 section
rowKey 对齐明细行
fieldKey 对齐字段
比较 value
展示 displayValue
```

也就是说，Diff 引擎不负责猜字段含义，也不负责临时查字典、查仓库、查供应商。

这些语义应该在快照构建阶段准备好。

例如：

```text
value = 2
displayValue = 已审核
displayValueI18nKey = operation.status.reviewed
```

Diff 比较 `value`，展示时用 `displayValue` 或 i18n 渲染。

新增行和删除行也可以按字段展开：

```text
新增行：oldValue = null, newValue = 实际值
删除行：oldValue = 原值, newValue = null
修改字段：oldValue != newValue
```

常见比较规则：

| 类型 | 比较方式 |
| --- | --- |
| STRING | 标准化后比较 |
| NUMBER | 按数字比较 |
| MONEY / QUANTITY | 按 BigDecimal 比较，忽略展示格式 |
| BOOLEAN | 按布尔值比较 |
| ENUM | 按枚举编码比较 |
| DATE / DATETIME | 按标准时间值比较 |
| OBJECT | 第一版不做深层比较，业务侧拆字段 |

空值策略也要收敛：

```text
null、空字符串、空集合不默认等同
```

如果某个业务希望把空字符串和 null 视为相同，应该在快照构建阶段标准化，而不是让 Diff 引擎猜。

## 7. 事件模型不要被落库表过早绑死

业务操作日志建议分成两层模型：

```text
业务中心内部事件模型
  -> 负责承载业务语义、快照、Diff、i18n 参数、上下文

日志中心落库命令模型
  -> 对齐账本表字段，负责跨系统传输和最终入库
```

不要一上来就让业务 Service 直接拼落库表字段。

原因很简单：

- 业务侧关心的是业务语义。
- 账本侧关心的是幂等、存储、查询和渲染。
- 二者变化节奏不同。

推荐链路是：

```text
BusinessOperationEvent
        |
        | 组装 humanTexts / extInfo / idempotentKey
        v
OperationLogCreateCommand
        |
        | MQ 或降级写入
        v
operation_log_ledger
```

这样可以避免业务事件被当前表结构过早锁死，也方便后续扩展：

```text
diffDetails
snapshot
i18nParams
captureWarnings
parseWarnings
traceId
userAgent
```

第一版复杂内容可以放在扩展信息里，但要有体积控制：

```text
maxDiffDetailCount
maxExtInfoBytes
maxDisplayValueLength
```

超过限制时，不要静默丢弃。应该写入采集告警：

```text
diff 明细已截断
展示值已截断
snapshot 体积超过限制
```

列表页也不要默认加载完整扩展信息，详情页再解析。

## 8. 成功日志必须在事务提交后投递

业务操作日志很容易出现一个隐蔽问题：

```text
业务事务回滚了，但操作日志已经写入成功。
```

这会让审计账本产生假事实。

例如：

```text
用户修改了采购单金额
日志显示修改成功
但业务事务最终回滚
数据库里采购单没有变化
```

所以成功日志的投递必须遵守：

```text
有事务：afterCommit 后投递
无事务：业务方法正常到达发布点后投递
事务回滚：不投递成功日志
```

这不代表日志系统要影响业务主流程。

更合理的是：

```text
业务成功提交
  -> afterCommit 发布日志消息
  -> MQ 异步消费
  -> 幂等落库
```

如果日志投递失败，应该进入日志、指标、重试或 DLQ 线索，而不是反向回滚业务事务。

业务主链路和日志链路的关系应该是：

```text
业务事务决定是否产生成功事实
日志系统负责可靠记录这个事实
日志系统失败不反向破坏业务事务
```

## 9. 幂等账本是审计系统的底线

业务操作日志一旦走异步，就必须考虑重复消息。

MQ 重试、pending 认领、消费超时、DLQ 重放、降级补偿，都可能导致同一条日志被投递多次。

所以账本表必须有幂等键。

幂等键的原始语义可以抽象为：

```text
requestId
actionKey
operationType
result
targetType
targetIdentity
logItemKey
```

再做摘要入库：

```text
idempotentKey = SHA-256(raw)
```

不要把原始长串直接塞进表里。

几个关键点：

### 9.1 result 要纳入幂等原文

失败日志和成功日志在审计语义上是两条不同日志。

如果某个客户端错误复用了同一个 requestId，不能让失败尝试和成功尝试互相覆盖。

### 9.2 logItemKey 只区分同次执行里的多个日志项

例如一次导入产生多条日志：

```text
logItemKey = ROW:1
logItemKey = ROW:2
logItemKey = ROW:3
```

或者一次导出没有具体业务对象：

```text
logItemKey = QUERY_HASH:<sha256>
```

它不能替代 requestId。

定时任务、系统补偿、外部回调也必须有稳定 requestId：

```text
jobName + fireTime + shardingId
compensationRunId
externalEventId
callbackId
```

### 9.3 账本唯一索引不应该跟普通业务表一样

普通业务表的唯一索引可能会带逻辑删除版本，用来支持删除后重建。

但操作日志是审计账本。

同一个 `idempotentKey` 即使历史日志被逻辑删除，补偿重放时也不应该重新插入一条新日志。

所以幂等唯一索引应该表达：

```text
同一个审计事实，只能入账一次。
```

消费端遇到重复消息：

```text
已存在：直接 ack
唯一索引冲突：直接 ack
可恢复异常：抛出，让 MQ 重试
不可恢复坏消息：进入 DLQ 或异常线索
```

重复消息不能反复重试，否则只会制造噪音。

## 10. 日志中心不要反查业务对象

业务操作日志查询有一个重要边界：

```text
日志中心只查日志账本，不反查业务对象。
```

也就是说，查询日志时不要再去查：

```text
商品详情
采购单详情
供应商信息
仓库信息
工单明细
```

原因有三个。

第一，历史日志应该表达历史事实，不应该被当前业务对象状态污染。

第二，日志中心如果依赖业务系统反查，会形成复杂跨中心依赖。

第三，业务对象可能已经删除、归档或迁移，日志仍然需要可读。

所以入库时就要准备好展示需要的信息：

```text
businessName
operationName
humanTexts
diffDetails
snapshot
i18nKey
i18nParams
```

查询时可以按当前语言重新渲染：

```text
入库保存 i18nKey + params + fallback humanTexts
查询时按当前语言渲染
渲染失败时回退入库 humanTexts
```

这比“入库时只存中文文案”更灵活，也比“查询时反查业务对象”更稳定。

## 11. 查询必须按租户和业务对象隔离

业务操作日志也是多租户数据。

查询不能只按：

```text
id
businessId
businessNo
```

必须带上租户隔离条件：

```text
ownerType + ownerId
```

业务详情页查询对象日志时，推荐条件是：

```text
ownerType + ownerId + targetType + businessId
```

单据类对象可以补充：

```text
targetType + businessNo
```

但不能只用单号查。

全局日志查询可以支持：

```text
moduleType
operationType
operationSource
targetType
businessNo
businessName
operator
requestId
result
operationTime
keywords
```

但要注意：不要对 `humanTexts` 和 `extInfo` 做大范围模糊搜索。

如果有关键词查询，最好强制带时间范围，例如：

```text
keywords + 最近 31 天
```

后续真要做全文检索，再引入 ES 或专门搜索存储，不要把 MySQL 主账本表直接拖垮。

## 12. 敏感字段默认不进日志

操作日志经常被当作审计证据，所以很多人会下意识认为“越全越好”。

这不对。

敏感字段默认不应该进入可见日志文本。

例如：

```text
密码
token
密钥
身份证完整号码
银行卡完整号码
手机号完整号码
隐私备注
```

控制点应该前移到快照阶段：

```text
Snapshot 构建：敏感字段默认不纳入白名单
Diff 生成：sensitive 字段不进入 humanTexts
extInfo 归并：敏感值脱敏或不写入
查询展示：按权限决定是否展示脱敏值
```

如果确实要记录，只记录脱敏值：

```text
138****8888
**** **** **** 1234
```

业务操作日志不是数据湖，不是越全越安全。

## 13. 常见误区

### 13.1 误区一：把所有字段变更都展示出来

结果通常是日志页面充满技术字段，业务人员看不懂。

正确方式是字段白名单。

```text
进入日志的字段必须有业务解释价值。
```

### 13.2 误区二：AOP 想吃掉所有场景

AOP 适合简单动作，不适合复杂多表业务。

复杂业务必须由 Service 显式提供 oldSnapshot 和 newSnapshot。

### 13.3 误区三：日志入库成功早于业务提交

这会产生假审计事实。

成功日志必须 afterCommit。

### 13.4 误区四：消费重复消息继续重试

重复消息不是异常。

幂等命中应该 ack 成功。

### 13.5 误区五：查询时依赖业务对象实时反查

这会让历史日志被当前数据污染。

展示需要的信息要在入库时准备好。

## 14. 一张图总结

![业务操作日志架构示意图](/assets/posts/business-operation-log/architecture.png)

业务操作日志的核心链路可以概括为：

```text
字段变化
  -> 业务语义建模
  -> 快照 Diff
  -> humanTexts
  -> afterCommit 投递
  -> MQ 重试 / DLQ
  -> 幂等账本落库
  -> 查询时渲染
```

它不是字段审计的替代品，而是更靠近业务侧的审计账本。

字段审计适合回答：

```text
哪个字段变了？
```

业务操作日志应该回答：

```text
谁对哪个业务对象做了什么动作？
这次动作产生了哪些关键业务变化？
这条日志是否可审计、可查询、可重放、可解释？
```

## 15. 最后总结

业务操作日志要做好的难点，不在于“能不能把字段变化记下来”。

真正难的是：

```text
如何定义业务动作
如何确定快照边界
如何只 Diff 有业务意义的字段
如何处理多表明细行对齐
如何保证事务提交后才入账
如何在异步链路下保证幂等
如何让历史日志脱离业务表也能被查询和解释
```

如果只做字段审计，系统能告诉你：

```text
status 从 1 变成 2
amount 从 80 变成 100
```

但一个合格的业务操作日志体系，应该能告诉你：

```text
张三在采购单详情页审核通过了采购单 PO-20260825001。
本次审核将单据状态从“待审核”变为“已审核”，新增一条审批意见，并触发后续入库待处理。
```

这才是业务系统真正需要的操作日志。

一句话：

```text
字段审计记录值变化，业务操作日志记录业务事实。
```
