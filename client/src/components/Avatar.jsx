import React from "react";

export function Avatar({ player }) {
  return (
    <img
      className="h-full w-full rounded-md shadow bg-white p-1"
      src={player.get("name") != "Facilitator" ? `https://api.dicebear.com/8.x/identicon/svg?rowColor=${player.get("hexCode")}` : "https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F"}
      alt="Avatar"
    />
  );
}
