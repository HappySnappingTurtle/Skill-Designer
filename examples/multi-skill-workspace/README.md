# 多 Skill 示例工作区

这个目录包含两个独立、可移植的 Skill Project：

- `skills/release-review`：具有有向流程的发布前审核 Skill。
- `skills/api-knowledge`：只有知识关系、不包含可执行流程的接口约定 Skill。

`example-workspace.json` 是仓库测试场景描述，不是产品的 Workspace 私有清单。要在页面中使用它，请新建一个 Workspace，然后分别通过“原地打开”加入上述两个 Skill 根目录。这样可以验证同一 Workspace 的多 Skill 切换，同时不会把本机绝对路径写入示例文件。
