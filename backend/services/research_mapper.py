"""Explicit previews; inferred/unknown facts never become marketing assertions."""
from datetime import datetime, timezone

from models.research import ProductSnapshot

LABELS = {'category': '类别', 'material': '材质', 'dimensions': '尺寸', 'features': '已核实特征', 'warranty': '已核实质保条款'}


def build_marketing_preview(snapshot, existing):
    value = ProductSnapshot.model_validate(snapshot)
    fields = []
    for fact in value.facts:
        if (value.merged or fact.state != 'confirmed' or fact.confirmation_method != 'manual'
                or not fact.confirmed_at or fact.confirmed_at > datetime.now(timezone.utc)
                or not fact.evidence_refs or not fact.value or not fact.value.strip()):
            continue
        target = 'productNameInput' if fact.key == 'product_name' else 'productFactsText'
        text = fact.value if fact.key == 'product_name' else LABELS.get(fact.key, fact.key) + ': ' + fact.value
        fields.append({'key': fact.key, 'label': '商品名称' if fact.key == 'product_name' else LABELS.get(fact.key, fact.key),
                       'target': target, 'value': text, 'existing': existing.get(target, ''), 'selected': False})
    return {'source_ref': value.source_ref.model_dump(mode='json'), 'market': value.market,
            'fields': fields, 'blocked_count': len(value.facts) - len(fields)}


def map_project_snapshot(project):
    """Reuse the original bounded projection, then enforce the legacy DTO."""
    from models.research import ProjectSnapshot
    from rabbit_hole.application.integration_contracts import project_snapshot
    return _validated_snapshot(project_snapshot(project), ProjectSnapshot)


def map_product_snapshot(project, product):
    from rabbit_hole.application.integration_contracts import product_snapshot
    return _validated_snapshot(product_snapshot(project, product), ProductSnapshot)


def _validated_snapshot(value, model):
    from pydantic import ValidationError

    from services.research_client import ResearchError
    try:
        return model.model_validate(value).model_dump(mode='json')
    except ValidationError:
        raise ResearchError('invalid_contract', '研究数据格式不兼容') from None
