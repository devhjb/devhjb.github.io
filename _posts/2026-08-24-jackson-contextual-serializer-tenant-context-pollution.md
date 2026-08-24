---
layout: post
title: "别把 ThreadLocal 写进 Serializer：一次 SaaS 多租户 Jackson 上下文污染排查"
date: 2026-08-24
category: "Java 排障"
series: "性能排查 02"
summary: "一次 SaaS 多租户场景下 Jackson ContextualSerializer 生命周期错配排查：请求级租户精度被复制进长期缓存的属性 serializer，导致后续租户复用错误配置。"
cover: "/assets/posts/jackson-context-pollution/cover.png"
featured: true
links:
  - label: "掘金"
    url: "https://juejin.cn/post/7677127513983303706"
  - label: "CSDN"
    url: "https://blog.csdn.net/qq_45481524/article/details/164018231?spm=1001.2014.3001.5501"
tags:
  - Java
  - Spring Boot
  - Jackson
  - 多租户
  - 性能排查
---

## 摘要

这次问题的表象很像前端金额计算错误：

```text
页面看到的订单金额：70
数据库里的订单金额：70.89
支付校验报错：页面提交金额与订单实际金额不一致
```

继续查下去会发现，数据库价格没有错，后端订单计算也没有错，真正丢掉 `0.89` 的地方发生在 HTTP 响应 JSON 序列化阶段。

根因是一个公共 Jackson `ContextualSerializer` 在 `createContextual()` 阶段读取了当前请求里的租户金额精度，并把这个请求级配置保存到了 serializer 实例字段里。Jackson 又会缓存上下文化后的属性序列化器，于是某个租户第一次触发某个 DTO 字段序列化时使用的精度，可能被后续租户继续复用。

一句话概括：

```text
ThreadLocal 本来隔离了请求，但代码把 ThreadLocal 的值复制进了 JVM 级缓存对象。
```

这不是典型的“商户 A 查到了商户 B 的数据”，而是另一类多租户问题：**租户配置污染**。

## 1. 问题现象：页面金额和订单金额对不上

某个前台交易场景里，支付时连续出现金额不一致：

```text
expected total = 70.89
current total = 70
```

页面上看到的商品价格可以抽象成：

```text
商品 A：27
商品 B：43
页面合计：70
```

但数据库里的订单明细是：

```text
商品 A：27.0000
商品 B：43.8900
订单总额：70.8900
```

第一反应通常会怀疑几类问题：

- 前端是不是把金额转成整数了？
- 后端是不是重新算订单时丢了小数？
- 数据库字段是不是 scale 不够？
- 某个价格等级、促销价、手工改价是不是覆盖了原价？

这些方向都要查，但不能先入为主。

这类问题最稳的排查方式是把金额沿链路切开：

```text
数据库原始值
  -> Service 内存值
  -> 响应 Model 值
  -> JSON 响应值
  -> 前端展示值
  -> 下单与支付校验值
```

最终定位到的变化点是：

```text
响应 Model 中仍然是 43.89
JSON 返回给前端时变成了 43
```

也就是说，问题不在数据库、不在订单计算，也不在前端传参，而是在 Jackson 写 JSON 的阶段发生了精度截断。

## 2. 先分清：数据穿透和配置污染不是一回事

多租户系统里，一听到“串租户”，很多人会马上想到数据隔离漏洞。

比如：

```text
当前请求 merchantId = B
SQL 却查到了 merchantId = A 的商品
```

这当然是严重问题，属于数据租户穿透。

但这次不是这种情况。

真实发生的是：

```text
商品数据：当前租户自己的 43.89
金额精度：错误沿用了另一个租户的 0 位精度
最终 JSON：43
```

也就是说，当前租户没有看到其他租户的商品数据，但当前租户的金额展示规则被别的租户污染了。

这同样是多租户隔离问题，只是泄漏对象不是业务数据，而是租户配置。

在 SaaS 系统里，租户配置也会影响业务正确性。金额精度、数量精度、时区、语言、税制、币种、权限策略、打印模板，都不能随意串。

## 3. 数据到底在哪一步变了

排查时先不要急着看框架源码，先证明业务数据在哪里开始失真。

可以把这次链路抽象成：

```text
商品基础价 = 43.8900
        ↓
定价服务返回 Amount(43.89)
        ↓
响应模型 setSellingPrice(43.89)
        ↓
Jackson 序列化 JSON
        ↓
selling_price = 43
        ↓
前端计算 27 + 43 = 70
        ↓
后端订单仍按 27 + 43.89 = 70.89 校验
        ↓
支付失败
```

这个链路非常关键。

如果没有证明 Model 到 JSON 这一步发生变化，很容易在价格服务、订单服务、支付服务里绕很久，甚至误判为“下单金额和支付金额口径不统一”。

但一旦确认：

```text
Java 对象里是 43.89
JSON 里是 43
```

问题范围就收敛到了 Jackson、自定义 serializer、全局 ObjectMapper 和请求上下文。

## 4. Jackson 的生命周期陷阱

大多数 Spring Boot 应用里，HTTP 响应 JSON 都会经过一个全局 `ObjectMapper`。

它通常是单例：

```text
一个 JVM
  -> 一个主要 ObjectMapper
  -> 处理所有请求
  -> 服务所有租户
```

为了统一金额、数量、日期、枚举、Long 等输出格式，项目里经常会注册自定义 serializer。

问题出在一个自定义金额 serializer 上。

它实现了类似 `ContextualSerializer` 的能力。这个接口本身没有问题，Jackson 也没有问题。它的用途是：根据字段上的稳定元数据，为某个属性创建专用 serializer。

稳定元数据包括：

```text
字段名
字段类型
字段注解
格式化注解
```

例如：

```text
OrderItemDTO.sellingPrice 是金额字段
OrderItemDTO.quantity 是数量字段
```

这些信息可以在 `createContextual()` 阶段读取并缓存。

但请求级信息不应该在这里缓存，例如：

```text
当前租户
当前用户
当前语言
当前时区
当前金额精度
当前权限
```

因为 `createContextual()` 返回的 serializer 可能跟着 BeanSerializer 一起被 Jackson 长期缓存。它不是每次请求都重新创建。

## 5. 根因：请求级配置被保存进了缓存对象

错误结构可以抽象成这样：

```java
public JsonSerializer<?> createContextual(SerializerProvider provider,
                                          BeanProperty property) {
    RequestContext context = RequestContextHolder.current();

    Integer moneyScale = context.getMoneyScale();
    Integer roundingMode = context.getRoundingMode();

    return new AmountSerializer(
            property.getName(),
            moneyScale,
            roundingMode
    );
}
```

然后在真正序列化时：

```java
public void serialize(Amount value,
                      JsonGenerator gen,
                      SerializerProvider provider) {
    Amount output = value.setScale(this.moneyScale, this.roundingMode);
    gen.writeString(output.toPlainString());
}
```

这段代码最大的问题不是 `ThreadLocal`，也不是 `ObjectMapper`，而是生命周期错配。

它把：

```text
请求级 moneyScale
```

保存进了：

```text
Jackson 缓存的 serializer 实例字段
```

于是就变成：

```text
请求 A：scale = 0
        ↓
首次触发某个 DTO 字段上下文化
        ↓
该字段 serializer 保存 scale = 0
        ↓
请求 B：scale = 3
        ↓
继续复用上一次缓存的 serializer
        ↓
43.89 仍按 scale = 0 输出为 43
```

示意图如下：

![生命周期错配示意图](/assets/posts/jackson-context-pollution/lifecycle.png)

## 6. 为什么不是所有接口同时出问题

这个问题很容易让人困惑：

```text
为什么菜单接口错了，另一个详情接口又是对的？
为什么同一个商品在 A 页面丢小数，在 B 页面又正常？
```

原因是 Jackson 的上下文化 serializer 通常挂在“响应模型 + 属性”上。

可以理解成：

```text
MenuItemDTO.sellingPrice      -> 一个属性 serializer
SkuDTO.sellingPrice           -> 另一个属性 serializer
OrderItemDTO.unitPrice        -> 又一个属性 serializer
```

它们虽然底层类型都是 `Amount`，JSON 字段也都像金额，但在 Jackson 缓存里不是同一个属性 writer。

因此可能出现：

```text
菜单模型 sellingPrice 第一次由 scale=0 的租户触发 -> 后续一直输出整数
SKU 模型 sellingPrice 第一次由 scale=3 的租户触发 -> 后续保留三位
订单模型 unitPrice 第一次由 scale=2 的租户触发 -> 后续保留两位
```

这也解释了为什么问题在多节点环境里更飘。

每个 JVM 都有自己的 Jackson 缓存：

```text
节点 A：某字段首次由 0 位精度租户触发
节点 B：同一字段首次由 3 位精度租户触发
节点 C：同一字段首次在无租户上下文下触发
```

于是相同接口，在不同节点上可能表现不同。

重启看似能恢复，是因为重启清掉了 JVM 内存缓存。但重启后哪个租户先访问，又会重新决定缓存状态。

重启能缓解，不代表根因消失。

## 7. 怎么证明是首次上下文化污染

单租户测试很难发现这个问题。

因为只用一个租户测，无论 serializer 是否错误缓存请求精度，结果都可能一致。

真正有价值的是顺序实验。

使用同一个 `ObjectMapper`、同一个响应模型、同一个金额字段，构造两个租户上下文：

```text
租户 A：scale = 0
租户 B：scale = 3
```

实验一：

```text
A -> B
```

如果结果是：

```text
A 输出 43
B 也输出 43
```

说明 B 没有使用自己的 3 位精度。

实验二：

```text
B -> A
```

如果结果是：

```text
B 输出 43.89
A 也输出 43.89
```

说明结果由第一次触发上下文化的租户决定。

再做一个跨模型实验：

```text
MenuItemDTO.sellingPrice 首次 scale=0 -> 输出 43
SkuDTO.sellingPrice 首次 scale=3      -> 输出 43.89
MenuItemDTO.sellingPrice 再次 scale=3 -> 仍输出 43
```

这样基本可以证明三件事：

1. 问题不是数据库精度。
2. 问题不是前端展示。
3. 同一个模型属性的 serializer 被首次请求污染，并被后续请求复用。

## 8. 修复目标：缓存结构，不缓存租户

正确修复不是关闭 Jackson 缓存。

Jackson 缓存本身是正常优化，问题是缓存对象里放了动态请求状态。

修复目标应该是：

```text
serializer 可以被缓存
serializer 只能缓存稳定字段语义
租户精度必须在每次 serialize 时从当前请求读取
```

也就是：

```java
public JsonSerializer<?> createContextual(SerializerProvider provider,
                                          BeanProperty property) {
    return new AmountSerializer(property.getName());
}
```

真正写 JSON 时再读取当前请求：

```java
public void serialize(Amount value,
                      JsonGenerator gen,
                      SerializerProvider provider) {
    RequestContext context = RequestContextHolder.current();

    Integer scale = context.getMoneyScale();
    Integer roundingMode = context.getRoundingMode();

    Amount output = value.setScale(scale, roundingMode);
    gen.writeString(output.stripTrailingZeros().toPlainString());
}
```

生命周期关系恢复为：

```text
JVM 级 serializer
  -> fieldName = sellingPrice
  -> fieldType = MONEY

请求 A ThreadLocal
  -> scale = 0
  -> 本次输出 43

请求 B ThreadLocal
  -> scale = 3
  -> 本次输出 43.89
```

注意这里不是说所有代码都必须在 `serialize()` 里读 ThreadLocal。核心原则是：**影响输出结果的动态变量，不能被提前复制进长期缓存对象。**

## 9. 为什么不选择这些方案

### 9.1 在 Controller 里手工格式化

这只能修当前接口。

其他 `Amount` 字段还会继续暴露，而且金额规则会散落到业务层，后续很容易出现接口之间口径不一致。

金额输出是横切规则，应该收敛在统一序列化层。

### 9.2 每个请求创建 ObjectMapper

这样确实能绕开缓存污染，但成本高，也容易遗漏全局 Jackson 配置。

而且它没有修复错误的生命周期设计，只是把问题藏起来。

### 9.3 每次请求清空 Jackson 缓存

这是非常危险的做法。

全局共享对象上频繁清缓存，会影响所有请求，引入并发竞争和性能抖动。并且清完以后，下一次请求仍然可能再次污染。

### 9.4 关闭 Jackson 缓存

缓存不是根因。

正确做法是让缓存对象保持无租户状态，而不是对抗框架正常优化机制。

### 9.5 按 tenantId 缓存 serializer

这看起来像是补全缓存键，但代价并不小：

- 商户数量增长会带来缓存容量问题。
- 租户配置变更后还要处理失效。
- 序列化器会被绑定到租户，复杂度继续上升。

更简单的方式是：只缓存字段结构，动态配置留在请求上下文里。

## 10. 回归测试应该怎么补

这类问题不能只测“某一个租户能不能返回正确金额”。

至少要覆盖这些维度。

### 10.1 顺序隔离

```text
scale=0 -> scale=3
scale=3 -> scale=0
```

结果必须只由当前请求决定，不能由第一次请求决定。

### 10.2 上下文隔离

```text
无上下文 -> 商户上下文
非商户上下文 -> 商户上下文
商户 A -> 商户 B
同一商户修改精度前后
```

尤其要测试“无上下文首次访问”。很多系统里，启动预热、健康检查、异步任务、内部调用都可能触发序列化。

### 10.3 字段类型

```text
price
amount
balance
quantity
非金额语义的 Amount 字段
```

如果项目靠字段名推断金额语义，就要非常小心，不要为了修一个字段，把所有 `Amount` 都当金额处理。

长期更好的方案是显式标注字段语义，例如：

```java
@AmountSemantic(MONEY)
private Amount serviceFee;

@AmountSemantic(QUANTITY)
private Amount weighedQuantity;

@AmountSemantic(RAW)
private Amount exchangeRate;
```

### 10.4 数值边界

```text
null
0
整数
28.5
43.8900
负数
大金额
尾随零
```

金额排障里，“数值相等”和“展示形式相同”不是一回事。

例如：

```text
数据库保留 28.500
JSON 输出 28.5
```

这可能是符合契约的。

但：

```text
数据库 28.500
JSON 输出 28
```

如果当前租户配置不是 0 位精度，那就是信息损失。

### 10.5 并发

两个线程共享同一个 `ObjectMapper`：

```text
线程 A：scale=0
线程 B：scale=3
```

同时反复序列化同一个模型字段，结果不得交叉。

这个测试能避免“顺序测试通过，并发下仍有共享状态”的问题。

## 11. 这次排查可以沉淀成几个原则

### 原则一：生命周期必须匹配

短生命周期数据不能保存到长生命周期共享对象。

常见危险组合包括：

```text
RequestContext -> Spring 单例字段
ThreadLocal -> static 字段
当前用户 -> 全局缓存值
当前语言 -> 单例 formatter 状态
当前租户 -> Jackson serializer 实例字段
```

这类问题最麻烦的地方是：单测、单租户、单节点、本地启动都可能正常。

一到多租户、多节点、不同访问顺序，就会变成偶现。

### 原则二：缓存键必须覆盖所有影响结果的变量

如果输出取决于：

```text
模型类型 + 字段 + 租户精度 + 舍入模式
```

缓存却只按：

```text
模型类型 + 字段
```

缓存就是不完整的。

但这不意味着要把所有动态变量都塞进缓存键。

更好的选择是：

```text
缓存稳定结构
动态变量运行期读取
```

### 原则三：多租户测试必须改变请求顺序

只测：

```text
A -> A -> A
```

发现不了上下文污染。

应该测：

```text
A -> B
B -> A
无上下文 -> A
非商户上下文 -> A
并发 A + B
```

顺序变化是发现缓存污染最直接的办法。

### 原则四：重启能恢复，往往是时序型故障信号

如果一个问题重启后恢复，但过一段时间又出现，要警惕：

```text
本地内存缓存
首次访问顺序
单例对象状态
预热过程
线程池复用
```

重启不是修复，只是把“第一次污染者”重新洗牌。

### 原则五：不要被方法名带偏

排查时经常会看到一些名字很像根因的方法，例如：

```text
findByIdCacheable
getContextCache
loadTenantConfig
```

方法名只能提示方向，不能替代证据。

这次排查里，请求上下文初始化本身是正确的，错误发生在后续 serializer 把上下文复制进缓存对象。

如果只看名字，很容易把锅甩给“商户缓存”或“ThreadLocal 失效”。

## 12. 最后总结

这次问题不是 Jackson 不安全，也不是 ThreadLocal 天然有问题。

真正的问题是：

```text
请求级租户配置
  -> 被 createContextual 读取
  -> 被保存到 serializer 实例字段
  -> serializer 被 Jackson 长期缓存
  -> 后续请求复用错误配置
```

排查这类问题，关键不是先找某个神奇参数，而是三步：

```text
先确认数据在哪一步变
再核对对象生命周期
最后用 A -> B / B -> A / 并发实验做证伪
```

多租户系统里，任何从 `ThreadLocal`、`SecurityContext`、`LocaleContext`、请求头或租户配置中心读取的数据，都要先问一句：

```text
这个值会不会被我放进了一个活得更久的对象里？
```

如果答案是会，那就已经埋下了上下文污染的种子。
