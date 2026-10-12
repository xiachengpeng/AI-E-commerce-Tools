"""Atomic facts/archive workflow. All business guards remain owned by original Store."""

from uuid import UUID

from models.research import SaveResearchImport
from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError

from services.research_client import ResearchError
from services.research_facade import ResearchFacade
from services.research_mapper import build_marketing_preview, map_product_snapshot
from services.research_repository import RepositoryError, ResearchRepository, digest


def import_request_digest(request):
    # New optional fields must not change previously committed remote receipts.
    value = dict(request)
    if value.get("confirmation") is None:
        value.pop("confirmation", None)
    return digest(value)


async def confirm_and_import(runtime, request: dict, import_id: UUID) -> dict:
    """Confirm optional human fact and persist its selected projection in one transaction."""
    from rabbit_hole.domain.project import WorkbenchError
    from rabbit_hole.persistence.sql import write_transaction

    try:
        project_id = str(UUID(str(request["project_id"])))
        product_id = str(UUID(str(request["product_id"])))
        body = SaveResearchImport.model_validate(
            {k: v for k, v in request.items() if k not in {"project_id", "product_id"}}
        )
        if body.import_id != UUID(str(import_id)) or not body.name.strip():
            raise ValueError
    except (KeyError, ValueError, TypeError, ValidationError):
        raise RepositoryError(422, "研究导入输入无效") from None
    normalized = {
        "project_id": project_id,
        "product_id": product_id,
        **body.model_dump(mode="json"),
    }
    request_digest = import_request_digest(normalized)
    if (
        runtime is None
        or runtime.engine is None
        or runtime.store is None
        or runtime.evidence_store is None
        or runtime.diagnostics
    ):
        raise RepositoryError(503, "本地研究运行时尚未就绪或仅允许读取")
    repo = ResearchRepository(runtime.paths.database)
    try:
        async with write_transaction(runtime.engine) as connection:
            previous = await repo.lookup_async(connection, import_id, request_digest)
            if previous:
                return previous
            raw = await runtime.store.get(project_id, _connection=connection)
            product = next((p for p in raw["products"] if p["id"] == product_id), None)
            if product is None:
                raise RepositoryError(404, "研究商品不存在")
            snapshot = map_product_snapshot(raw, product)
            ref = snapshot["source_ref"]
            if (
                ref["source_version"] != body.expected_source_version
                or ref["identity_revision"] != body.expected_identity_revision
                or snapshot["market"] != body.expected_market
            ):
                raise RepositoryError(409, "研究资料或商品身份已更新，请刷新后重新预览")
            confirmation = body.confirmation
            if confirmation is not None:
                if (
                    confirmation.expected_version != body.expected_source_version
                    or confirmation.identity_revision != body.expected_identity_revision
                    or confirmation.market != body.expected_market
                ):
                    raise RepositoryError(
                        409, "确认与导入的研究版本、商品身份或国家不一致"
                    )
                data = confirmation.model_dump(mode="json")
                await runtime.store.command(
                    project_id,
                    confirmation.expected_version,
                    str(confirmation.command_id),
                    "confirm_marketing_fact",
                    {
                        **{
                            k: v
                            for k, v in data.items()
                            if k not in {"command_id", "expected_version"}
                        },
                        "product_id": product_id,
                    },
                    _connection=connection,
                )
                raw = await runtime.store.get(project_id, _connection=connection)
                product = next(p for p in raw["products"] if p["id"] == product_id)
                snapshot = map_product_snapshot(raw, product)
            accepted = set(body.selected_fields)
            preview = build_marketing_preview(snapshot, {})
            if not accepted.issubset({field["key"] for field in preview["fields"]}):
                raise RepositoryError(409, "所选事实未核实或已失效，请重新核对")
            saved = {
                **snapshot,
                "facts": [
                    fact for fact in snapshot["facts"] if fact["key"] in accepted
                ],
            }
            return await repo.save_async(
                connection, import_id, request_digest, body.name.strip(), saved
            )
    except WorkbenchError as exc:
        raise ResearchFacade._error(exc) from None
    except SQLAlchemyError:
        raise ResearchError(
            "unavailable", "研究导入未完成，请核对操作状态", 503
        ) from None
