import React, { useEffect, useRef, useState } from "react";

// Simple WebSocket Dashboard
// Drop this file into a React + Tailwind project (e.g. /src/components/WsDashboard.tsx)
// - No external UI libs required
// - Configure the API base and WS URL below
// - The component lets you submit a simple market order and watch lifecycle events

const DEFAULT_API_BASE = "http://localhost:3000";
const DEFAULT_WS_BASE = "ws://localhost:3000/ws"; // adjust if your server uses a different path/port

type OrderEvent = {
    orderId?: string;
    status: string;
    ts?: string;
    txHash?: string;
    error?: string;
    [k: string]: any;
};

export default function WsDashboard() {
    const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
    const [wsBase, setWsBase] = useState(DEFAULT_WS_BASE);
    const [connected, setConnected] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);
    const [events, setEvents] = useState<OrderEvent[]>([]);
    const [orderId, setOrderId] = useState<string>("");
    const [subscribedOrder, setSubscribedOrder] = useState<string>("");
    const [log, setLog] = useState<string[]>([]);
    const [amount, setAmount] = useState<number>(1);
    const [tokenIn, setTokenIn] = useState<string>("SOL");
    const [tokenOut, setTokenOut] = useState<string>("USDC");

    useEffect(() => {
        return () => {
            if (wsRef.current) {
                try {
                    wsRef.current.close();
                } catch (e) { }
            }
        };
    }, []);

    function appendLog(s: string) {
        setLog((l) => [new Date().toISOString() + " — " + s, ...l].slice(0, 200));
    }

    const connect = (orderToSubscribe?: string) => {
        if (wsRef.current) {
            try {
                wsRef.current.close();
            } catch (e) { }
            wsRef.current = null;
        }

        // prefer query param subscription if the server supports it
        const connectUrl = orderToSubscribe ? `${wsBase}?orderId=${orderToSubscribe}` : wsBase;
        appendLog(`Connecting to ${connectUrl}`);
        const ws = new WebSocket(connectUrl);
        wsRef.current = ws;

        ws.onopen = () => {
            setConnected(true);
            appendLog("WebSocket opened");
            if (orderToSubscribe) setSubscribedOrder(orderToSubscribe);
            // If server expects a subscribe message
            if (orderToSubscribe) {
                try {
                    ws.send(JSON.stringify({ type: "subscribe", orderId: orderToSubscribe }));
                    appendLog(`Sent subscribe message for ${orderToSubscribe}`);
                } catch (e) { }
            }
        };

        ws.onmessage = (ev) => {
            try {
                const payload = JSON.parse(ev.data as string);
                appendLog(`Message: ${JSON.stringify(payload)}`);
                if (payload && payload.orderId) setOrderId(payload.orderId);
                setEvents((e) => [payload, ...e].slice(0, 500));
            } catch (err) {
                appendLog("Received non-JSON message: " + String((ev as any).data));
            }
        };

        ws.onclose = () => {
            setConnected(false);
            appendLog("WebSocket closed");
        };

        ws.onerror = (err) => {
            appendLog("WebSocket error (check server)" + JSON.stringify(err));
        };
    };

    const disconnect = () => {
        if (wsRef.current) {
            try {
                wsRef.current.close();
            } catch (e) { }
            wsRef.current = null;
        }
        setConnected(false);
        setSubscribedOrder("");
        appendLog("Disconnected");
    };

    const submitOrder = async () => {
        // Simple market order payload for the mock backend
        const payload = {
            type: "market",
            tokenIn,
            tokenOut,
            amount: Number(amount),
        };

        appendLog(`POST ${apiBase}/api/orders/execute -> ${JSON.stringify(payload)}`);
        try {
            const res = await fetch(`${apiBase}/api/orders/execute`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            appendLog(`Order submitted, server returned: ${JSON.stringify(data)}`);
            if (data?.orderId) {
                setOrderId(data.orderId);
                // auto-connect and subscribe to this order
                connect(data.orderId);
            }
        } catch (err) {
            appendLog("Order submit failed: " + String(err));
        }
    };

    const clearEvents = () => setEvents([]);

    return (
        <div className="min-h-screen bg-gray-50 p-6">
            <div className="max-w-6xl mx-auto">
                <header className="mb-6">
                    <h1 className="text-2xl font-semibold">Order Execution — WebSocket Dashboard</h1>
                    <p className="text-sm text-gray-600">Simple viewer for WS lifecycle events (pending → routing → confirmed/failed).</p>
                </header>

                <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="col-span-1 bg-white p-4 rounded-lg shadow-sm">
                        <h2 className="font-medium mb-2">Connection</h2>
                        <label className="block text-xs text-gray-600">API base</label>
                        <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} className="w-full p-2 border rounded mb-2" />
                        <label className="block text-xs text-gray-600">WebSocket URL</label>
                        <input value={wsBase} onChange={(e) => setWsBase(e.target.value)} className="w-full p-2 border rounded mb-2" />
                        <div className="flex gap-2 mt-2">
                            <button onClick={() => connect(subscribedOrder || orderId)} className="px-3 py-2 bg-blue-600 text-white rounded">Connect</button>
                            <button onClick={disconnect} className="px-3 py-2 bg-gray-200 rounded">Disconnect</button>
                        </div>

                        <div className="mt-4 text-sm">
                            <div>Connected: <strong>{connected ? "Yes" : "No"}</strong></div>
                            <div>Subscribed order: <strong>{subscribedOrder || "—"}</strong></div>
                            <div>Known orderId: <strong>{orderId || "—"}</strong></div>
                        </div>
                    </div>

                    <div className="col-span-2 bg-white p-4 rounded-lg shadow-sm">
                        <h2 className="font-medium mb-2">Submit Order</h2>
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                            <input className="p-2 border rounded" value={tokenIn} onChange={(e) => setTokenIn(e.target.value)} />
                            <input className="p-2 border rounded" value={tokenOut} onChange={(e) => setTokenOut(e.target.value)} />
                            <input className="p-2 border rounded" type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
                            <button onClick={submitOrder} className="px-3 py-2 bg-green-600 text-white rounded">Submit Market Order</button>
                        </div>

                        <div className="mt-4">
                            <h3 className="font-medium">Recent Events</h3>
                            <div className="mt-2 max-h-64 overflow-auto border rounded p-2 bg-gray-50">
                                {events.length === 0 && <div className="text-sm text-gray-500">No events yet</div>}
                                {events.map((ev, idx) => (
                                    <div key={idx} className="p-2 mb-1 border-b last:border-b-0">
                                        <div className="flex items-baseline gap-2">
                                            <div className="text-xs text-gray-500">{ev.ts || new Date().toISOString()}</div>
                                            <div className="text-sm font-medium">{ev.status}</div>
                                            <div className="text-xs text-gray-500">{ev.orderId ? `— ${ev.orderId}` : ""}</div>
                                            {ev.txHash && <div className="ml-auto text-xs">tx: {String(ev.txHash).slice(0, 12)}</div>}
                                        </div>
                                        <pre className="text-xs mt-1 overflow-auto">{JSON.stringify(ev, null, 2)}</pre>
                                    </div>
                                ))}
                            </div>
                            <div className="mt-2 flex gap-2">
                                <button onClick={clearEvents} className="px-2 py-1 rounded bg-gray-200 text-sm">Clear</button>
                            </div>
                        </div>
                    </div>
                </section>

                <section className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-white p-4 rounded-lg shadow-sm">
                        <h3 className="font-medium mb-2">Raw Logs</h3>
                        <div className="max-h-52 overflow-auto text-xs bg-gray-900 text-white p-2 rounded">
                            {log.map((l, i) => (
                                <div key={i} className="mb-1">{l}</div>
                            ))}
                        </div>
                    </div>

                    <div className="bg-white p-4 rounded-lg shadow-sm">
                        <h3 className="font-medium mb-2">Quick Controls / Debug</h3>
                        <div className="text-sm text-gray-600">You can paste a previously-seen orderId to subscribe directly.</div>
                        <div className="flex gap-2 mt-2">
                            <input value={subscribedOrder} onChange={(e) => setSubscribedOrder(e.target.value)} className="p-2 border rounded flex-1" placeholder="orderId to subscribe" />
                            <button onClick={() => connect(subscribedOrder)} className="px-3 py-2 bg-blue-600 text-white rounded">Subscribe</button>
                        </div>

                        <div className="mt-4 text-xs text-gray-500">
                            Note: This dashboard assumes your server exposes POST /api/orders/execute that returns {orderId} and a WS endpoint at the configured URL which either accepts a query param <code>?orderId=</code> or a JSON subscribe message <code>{`{type:'subscribe',orderId}`}</code>.
                        </div>

                        <div className="mt-4 text-xs text-gray-500">
                            For the task spec PDF used while building the backend see:
                            <div className="mt-2 p-2 bg-gray-100 rounded text-xs break-words">/mnt/data/Backend Task 2_ Order Execution Engine.pdf</div>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
}
