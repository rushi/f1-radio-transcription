import aiohttp

# MultiViewer's local GraphQL API, which exposes the F1 live timing state for the session being watched
MULTIVIEWER_URL = "http://localhost:10101/api/graphql"


async def query_multiviewer(http: aiohttp.ClientSession, query: str) -> dict:
    async with http.post(MULTIVIEWER_URL, json={"query": query}) as response:
        if not response.ok:
            raise RuntimeError(f"MultiViewer HTTP {response.status}")
        return await response.json()
