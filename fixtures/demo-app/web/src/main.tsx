import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Home } from './pages/Home';
import { Account } from './pages/Account';

type Route = 'home' | 'account';

// Tiny hash-free router: two pages, a toggle. Swap for react-router when the
// storefront grows past a demo.
function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>('home');
  return (
    <>
      <nav>
        <button onClick={() => setRoute('home')}>Shop</button>
        <button onClick={() => setRoute('account')}>Account</button>
      </nav>
      {route === 'home' ? <Home /> : <Account />}
    </>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
