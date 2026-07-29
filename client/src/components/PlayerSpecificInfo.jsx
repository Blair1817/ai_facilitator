import React, { useState } from "react";
import { Tabs, Tab, Box, Container } from "@mui/material";
import { usePlayer, usePlayers, useStage, useGame } from "@empirica/core/player/classic/react";
import { RenderMarkdown } from "./RenderMarkdown.jsx";
import "../../node_modules/@empirica/core/dist/player-classic-react.css";

export function PlayerSpecificInfo() {
  const player = usePlayer();
  const players = usePlayers();
  const stage = useStage();
  const game = useGame();
  // Round-first: the current round's private profile should live at
  // player.round.get("playerContent") once the backend sets it per round.
  // Falls back to the old flat player.get("playerContent") for compatibility
  // with the current (unmodified) backend, which only sets it once at the
  // player level via callbacks.js's onGameStart shuffle. Both reads are
  // scoped to the current player only (usePlayer(), never usePlayers()) --
  // this must never read another participant's profile.
  const playerContent = player.round?.get("playerContent") ?? player.get("playerContent");
  const playerName = player.get("name");
  const generalInfo = game.get("generalInfo");
  const [selectedTab, setSelectedTab] = useState(0);

  const handleChange = (event, newValue) => {
    setSelectedTab(newValue);
  };

  if (!playerContent) {
    return (
      <div className="h-full w-full flex items-center justify-center text-gray-500">
        This session is not yet available. Please contact the research team.
      </div>
    );
  }

  const playerSpecificInfo = [
    { label: `Personal report for ${player.get("name")}`, content: playerContent },
  ];

  const facilitatorInfo = [
    { label: `Facilitator Notes`, content: playerContent },
  ];

  const tabContent = playerName === "Facilitator" ? facilitatorInfo : playerSpecificInfo;

  return (
    <Container maxWidth="lg" style={{
      backgroundColor: "white",
      borderRadius: "8px",
      width: "100%",
      boxSizing: "border-box", // Add this to ensure padding is included in the width calculation
      textAlign: "center",
      height: "calc(100vh - 100px)",
      paddingTop: "2rem",
    }}>
      <h3 className="text-lg leading-6 font-bold text-gray-900">Review the information available below, and discuss the city selection with your group.</h3>
      <div className="text-gray-600 text-sm pb-5">(Once time runs out, the task will proceed automatically.)</div>
      <Tabs
        value={selectedTab}
        onChange={handleChange}
        aria-label="image tabs"
        variant="fullWidth"
        centered
        style={{ borderBottom: "1px solid #e0e0e0" }}
        TabIndicatorProps={{ style: { display: 'none' } }} // Hide the default indicator
      >
        {tabContent.map((image, index) => (
          <Tab
            label={image.label}
            key={index}
            style={{
              fontWeight: selectedTab === index ? 'bold' : 'normal',
              color: selectedTab === index ? '#3f51b5' : 'black',
              border: selectedTab === index ? '3px solid #3f51b5' : '2px solid #e0e0e0',
              borderBottom: 'none', // Prevent double border at the bottom
              borderTopLeftRadius: '8px',
              borderTopRightRadius: '8px',
              backgroundColor: selectedTab === index ? '#f0f0f0' : 'transparent',
              width: "50%", 
              boxSizing: "border-box", // Ensure borders and padding are included in the width
            }}
          />
        ))}
      </Tabs>
      <Box className="overflow-auto w-full"
        style={{
          border: "2px solid #e0e0e0",
          borderTop: "none",
          borderBottomLeftRadius: "8px",
          borderBottomRightRadius: "8px",
          width: "100%", // Ensure the box takes full width
          boxSizing: "border-box", // Ensure borders and padding are included in the width
          height: "calc(80vh - 100px)"
        }}>
        {tabContent.map((image, index) => (
          <Box
            role="tabpanel"
            className="px-10 pt-4"
            hidden={selectedTab !== index}
            key={index}
            style={{ height: "80vh", textAlign: "left", width: "100%", maxWidth: "none" }}
          >
            {selectedTab === index && (
              <RenderMarkdown markdownText={image.content} />
            )}
          </Box>
        ))}
      </Box>
    </Container>
  );
}
