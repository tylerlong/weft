# Weft

Existing Agent and workflow terminology is defined in [CONTEXT.md](CONTEXT.md#language).

## Language

**Configured model（已配置模型）**:
用户保存到 Weft 的模型，独立于该模型当前是否可用；服务方策略变化不代表用户删除了该配置。
_Avoid_: Available model, enabled model

**Available model（可用模型）**:
当前 API key 最近一次成功发现所返回的模型，符合服务方当时生效的访问限制；不保证任意后续模型调用成功。
_Avoid_: Guaranteed model, company-approved model

**Provider routing preference（服务方路由偏好）**:
用户对同一模型的服务方选择所表达的优先目标：沿用 OpenRouter 默认策略、最低价格、最高吞吐量或最低延迟。偏好不构成价格上限、性能保证或指定服务方的限制。
_Avoid_: Budget limit, speed guarantee, provider selection
