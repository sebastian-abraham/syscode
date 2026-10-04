import React from 'react';
import { Orders } from '../components/Orders';

// Account page: shows order history. Auth is handled by the cookie the login
// flow sets, so this page just renders the list.
export function Account(): React.JSX.Element {
  return (
    <main className="account">
      <h1>Your account</h1>
      <Orders />
    </main>
  );
}
