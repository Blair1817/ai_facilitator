import zIndex from "@mui/material/styles/zIndex.js";
import { height } from "@mui/system";
import { makeRegexClassGroup } from "unocss";

export default {
    control: {
      backgroundColor: '#fff',
      fontSize: 14,
      fontWeight: 'normal',
    },
  
    '&multiLine': {
      display: 'inline-block',
      width: "100%",
      height: "8rem",
      
      control: {
        
      },

      highlighter: {
        padding: 9,
        border: '1px solid transparent',
      },

      input: {
        padding: 9,
        border: '1px solid silver',
        height: "90%", 
        maxHeight: "90%",     
        overflow: 'auto',
        resize: 'none',
      },
    },
  
    '&singleLine': {
      display: 'inline-block',
      width: "100%",
  
      highlighter: {
        padding: 1,
        border: '2px inset transparent',
      },
      input: {
        padding: 1,
        border: '2px inset',
      },
    },
  
    suggestions: {
      list: {
        backgroundColor: 'white',
        border: '1px solid rgba(0,0,0,0.15)',
        fontSize: 14,
        position: 'absolute',
        zIndex: 10,
        marginTop: -70,
      },
      item: {
        padding: '5px 15px',
        borderBottom: '1px solid rgba(0,0,0,0.15)',
        '&focused': {
          backgroundColor: '#cee4e5',
        },
      },
    },
  }