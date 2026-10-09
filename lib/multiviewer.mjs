// MultiViewer's local GraphQL API, which exposes the F1 live timing state for the session being watched
export const MULTIVIEWER_URL = 'http://localhost:10101/api/graphql';

export const queryMultiViewer = async (query) => {
    const response = await fetch(MULTIVIEWER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
    });
    if (!response.ok) {
        throw new Error(`MultiViewer HTTP ${response.status}`);
    }
    return response.json();
};
