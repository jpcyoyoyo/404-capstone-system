import React from 'react';
import { Redirect, Route, RouteProps, RouteComponentProps } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

interface PrivateRouteProps extends Omit<RouteProps, 'component' | 'render' | 'children'> {
  component: React.ComponentType<RouteComponentProps>;
}

/** Renders `component` only when a session exists; otherwise redirects to /login. */
const PrivateRoute: React.FC<PrivateRouteProps> = ({ component: Component, ...rest }) => {
  const { isAuthenticated } = useAuth();
  return (
    <Route
      {...rest}
      render={(props) => (isAuthenticated ? <Component {...props} /> : <Redirect to="/login" />)}
    />
  );
};

export default PrivateRoute;
