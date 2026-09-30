from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Unpack

from switch_core.clients.client_base import (
    ClientBase,
    ClientBaseKwargs,
    ClientConfig,
)
from switch_core.transport import InboundMedia, InboundMessage, RoomRef

if TYPE_CHECKING:
    from switch_core.bridges.collaboration.collaboration_core import CollaborationCore

logger = logging.getLogger(__name__)


class WorkspaceConsumerConfig(ClientConfig):
    bridge_id: str


class WorkspaceConsumer(ClientBase[WorkspaceConsumerConfig]):
    config_class = WorkspaceConsumerConfig

    def __init__(
        self,
        *,
        collaboration_core: CollaborationCore,
        **kwargs: Unpack[ClientBaseKwargs[WorkspaceConsumerConfig]],
    ) -> None:
        super().__init__(**kwargs)
        self._collaboration_core = collaboration_core

    async def on_message(self, room: RoomRef, event: InboundMessage) -> None:
        logger.debug(
            "[WORKSPACE-CONSUMER] on_message room=%s sender=%s",
            room.room_id,
            event.sender,
        )
        await self._collaboration_core.handle_outbound_message(room, event)

    async def on_media(self, room: RoomRef, event: InboundMedia) -> None:
        logger.debug(
            "[WORKSPACE-CONSUMER] on_media room=%s sender=%s",
            room.room_id,
            event.sender,
        )
        await self._collaboration_core.handle_outbound_media(room, event, self)
