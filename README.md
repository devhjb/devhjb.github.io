# Jabbey

Java 后端开发，关注 SaaS ERP、库存系统、生产系统、B 端业务架构和后端性能排查。

这个仓库用于托管个人技术主页：[https://devhjb.github.io](https://devhjb.github.io)

## 站点结构

当前站点使用 GitHub Pages 原生支持的 Jekyll 结构：

- `_posts/`：文章 Markdown 源文件，后续新增文章优先放这里。
- `_layouts/`：首页和文章页共用布局模板。
- `assets/posts/`：文章图片资源。
- `index.html`：首页 Liquid 模板，自动读取 `site.posts`。

## 当前定位

- SaaS ERP 业务建模
- 库存与生产系统设计
- Java / Spring Boot 后端工程架构
- Java 后端性能排查、SQL 审计和数据库链路优化
- 状态机、事务一致性、幂等与审计

## 文章系列

- 库存不是一个数字：从 On Hand 到 Available、Reserved 的销售订单库存预留设计
- 热敏打印不是 exactly-once：餐饮 POS 打印任务的 Claim、兜底与结果未知治理
- 列表导出不够用：SaaS ERP 单据详情导出的 Provider、模板与文档型 Excel 设计
- 别被 saveBatch 骗了：一次 MyBatis-Plus 批量插入性能排查
- 轻制造 SaaS 的生产闭环建模：BOM、工单、领料、报工、质检与入库
- 库存驱动生产系统里的事务、幂等、预占与在制台账设计
- 为什么中小工厂不一定需要 MES，而更需要 MRP Lite？

## 公开与隐私边界

这个仓库是公开展示层，只放适合对外发布的内容。

后续如果把个人 MyVault 纳入 Git 管理，建议采用双仓库结构：

- 私有仓库：保存完整 MyVault、原始笔记、项目复盘、草稿和不适合公开的内容。
- 公开仓库：保存从私有知识库中筛选、脱敏、改写后的文章和作品集页面。

不要把完整 MyVault 直接推到这个公开仓库。公开内容应该经过筛选、脱敏和二次编辑。
