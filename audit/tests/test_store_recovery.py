import asyncio
import unittest

from app import store


class StoreRecoveryTests(unittest.TestCase):
    def tearDown(self):
        store._mem.clear()

    def test_active_snapshot_contains_task_id_and_is_recoverable(self):
        async def scenario():
            await store.save_task("task-123", {
                "status": "running",
                "url": "https://example.com",
                "config": {"url": "https://example.com", "max_pages": 10},
                "progress": {"crawled": 3},
            })
            active = await store.list_active_tasks()
            self.assertEqual(len(active), 1)
            self.assertEqual(active[0]["task_id"], "task-123")
            self.assertEqual(active[0]["status"], "running")

        asyncio.run(scenario())

    def test_terminal_snapshot_is_not_recovered(self):
        async def scenario():
            await store.save_task("done-task", {"status": "done", "url": "https://example.com"})
            self.assertEqual(await store.list_active_tasks(), [])

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
